<?php
/**
 * NetShare — PHP Samba Backend
 * Single-file REST API that shells out to `smbclient` for all SMB operations.
 *
 * Prerequisites:
 *	 sudo apt install samba-client php php-cli		(Debian/Ubuntu)
 *	 sudo dnf install samba-client php php-cli		(RHEL/Fedora)
 *
 * Drop into any Apache/Nginx/Lighttpd + PHP-FPM vhost.
 *
 * Routes (all JSON in/out):
 *	 POST	/api/connect				– validate credentials, create session
 *	 DELETE /api/connect/{id}			– destroy session
 *	 GET	/api/files/{id}				– list directory	 ?path=sub/dir
 *	 GET	/api/files/{id}/download	– download file	 ?path=file.txt
 *	 POST	/api/files/{id}/upload		– upload files	 ?path=target/dir
 *	 POST	/api/files/{id}/mkdir		– create directory
 *	 DELETE /api/files/{id}				– delete file/dir
 *	 PATCH	/api/files/{id}/rename		– rename / move
 *	 GET	/api/health					– health check
 */

declare(strict_types=1);

// ── CORS ────────────────────────────────────────────────────────────────────
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, DELETE, PATCH, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Session-Id');
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
	http_response_code(204);
	exit;
}

// ── SESSION STORE ────────────────────────────────────────────────────────────
// Sessions are stored as JSON files in a temp directory.
// Each file: { host, port, share, username, password, domain, created, lastAccess }
define('SESSION_DIR', sys_get_temp_dir() . '/netshare_sessions');
define('SESSION_TTL', 1800); // 30 minutes

if (!is_dir(SESSION_DIR)) {
	mkdir(SESSION_DIR, 0700, true);
}

function sessionPath(string $id): string {
	// Only allow safe session IDs (UUID v4 format)
	if (!preg_match('/^[0-9a-f\-]{36}$/', $id)) return '';
	return SESSION_DIR . '/' . preg_replace('/[^a-f0-9\-]/', '', $id) . '.json';
}

function sessionLoad(string $id): ?array {
	$p = sessionPath($id);
	if (!$p || !file_exists($p)) return null;
	$data = json_decode(file_get_contents($p), true);
	if (!$data) return null;
	// Check TTL
	if (time() - $data['lastAccess'] > SESSION_TTL) {
		unlink($p);
		return null;
	}
	return $data;
}

function sessionSave(string $id, array $data): void {
	$p = sessionPath($id);
	if (!$p) return;
	file_put_contents($p, json_encode($data), LOCK_EX);
	chmod($p, 0600);
}

function sessionTouch(string $id, array $data): array {
	$data['lastAccess'] = time();
	sessionSave($id, $data);
	return $data;
}

function sessionDelete(string $id): void {
	$p = sessionPath($id);
	if ($p && file_exists($p)) unlink($p);
}

function gcSessions(): void {
	foreach (glob(SESSION_DIR . '/*.json') as $f) {
		$data = json_decode(file_get_contents($f), true);
		if (!$data || time() - $data['lastAccess'] > SESSION_TTL) {
			unlink($f);
		}
	}
}

// GC on ~5% of requests
if (rand(1, 20) === 1) gcSessions();

// ── SMBCLIENT HELPERS ─────────────────────────────────────────────────────────

/**
 * Run smbclient with an inline command string.
 * Returns ['stdout' => string, 'stderr' => string, 'exit' => int]
 */
function smbRun(array $cfg, string $command): array {
//file_put_contents('SMB.txt',"$command\n",FILE_APPEND);
	$unc		= sprintf('//%s/%s', escapeshellarg($cfg['host']), escapeshellarg($cfg['share']));
	$userPass	= sprintf('%s%%%s', $cfg['username'], $cfg['password']);

	// Build arg list — never interpolate password into shell string
	$args = [
		'smbclient',
		sprintf('//%s/%s', $cfg['host'], $cfg['share']),
		'--port', (string)($cfg['port'] ?? 445),
		'--workgroup', $cfg['domain'] ?? 'WORKGROUP',
	//	'--user', $userPass,
	//	'--no-pass',
		'--user', $cfg['username'],
		'--password', $cfg['password'],
		'--command', $command,
	];

	// Use proc_open so we can capture stdout + stderr separately
	$descriptors = [
		0 => ['pipe', 'r'],	// stdin
		1 => ['pipe', 'w'],	// stdout
		2 => ['pipe', 'w'],	// stderr
	];

	$proc = proc_open($args, $descriptors, $pipes);
	if (!is_resource($proc)) {
		return ['stdout' => '', 'stderr' => 'Failed to spawn smbclient', 'exit' => 1];
	}

	fclose($pipes[0]);
	$stdout = stream_get_contents($pipes[1]);
	$stderr = stream_get_contents($pipes[2]);
	fclose($pipes[1]);
	fclose($pipes[2]);
	$exit = proc_close($proc);

	return ['stdout' => $stdout, 'stderr' => $stderr, 'exit' => $exit];
}

/**
 * Run smbclient and throw on fatal SMB errors.
 */
function smbCmd(array $cfg, string $command): string {
	$r = smbRun($cfg, $command);

	// smbclient exits non-zero on errors, but also sometimes on success
	// Check stderr for NT_STATUS errors as the reliable signal
	if (isFatalSmbError($r['stderr']) || isFatalSmbError($r['stdout'])) {
		throw new RuntimeException(parseSmbError($r['stderr'] . "\n" . $r['stdout']));
	}
	if ($r['exit'] !== 0 && $r['exit'] !== 1) {
		// exit 1 is common even on success; only fail on higher codes
		throw new RuntimeException(parseSmbError($r['stderr'] ?: $r['stdout']));
	}

	return $r['stdout'];
}

function isFatalSmbError(string $s): bool {
	if ($s === '') return false;
	$lower = strtolower($s);
	return str_contains($lower, 'nt_status_')
		|| str_contains($lower, 'access denied')
		|| str_contains($lower, 'bad password')
		|| str_contains($lower, 'logon failure')
		|| str_contains($lower, 'invalid network')
		|| str_contains($lower, 'connection refused');
}

function parseSmbError(string $msg): string {
	if ($msg === '') return 'Unknown SMB error';

	$map = [
		'NT_STATUS_LOGON_FAILURE'		 => 'Authentication failed — check username/password.',
		'NT_STATUS_ACCESS_DENIED'		 => 'Access denied.',
		'NT_STATUS_BAD_NETWORK_NAME'	 => 'Share not found on server.',
		'NT_STATUS_OBJECT_NAME_NOT_FOUND'=> 'File or folder not found.',
		'NT_STATUS_OBJECT_NAME_COLLISION'=> 'File or folder already exists.',
		'NT_STATUS_CONNECTION_REFUSED'	 => 'Connection refused — is the server reachable?',
		'NT_STATUS_HOST_UNREACHABLE'	 => 'Host unreachable — check the IP/hostname.',
		'NT_STATUS_IO_TIMEOUT'			 => 'Connection timed out.',
		'NT_STATUS_NO_SUCH_FILE'		 => 'File not found.',
		'NT_STATUS_NOT_A_DIRECTORY'		 => 'Not a directory.',
		'NT_STATUS_DIRECTORY_NOT_EMPTY'	 => 'Directory is not empty.',
	];

	if (preg_match('/NT_STATUS_\w+/i', $msg, $m)) {
		$key = strtoupper($m[0]);
		return $map[$key] ?? $key;
	}

	// Return the last meaningful line
	$lines = array_filter(array_map('trim', explode("\n", $msg)));
	return end($lines) ?: $msg;
}

/**
 * Parse `smbclient -c ls` output into an array of entry arrays.
 *
 * Example lines:
 *	 Documents							 D		0	Mon Mar 10 14:22:00 2025
 *	 readme.txt							 A	1024	Mon Jan  4 09:00:00 2025
 */
function parseLs(string $stdout): array {
	$entries = [];
	foreach (explode("\n", $stdout) as $line) {
		// Match: name	ATTRS size	 date
		if (!preg_match('/^  (.+?)\s{2,}([A-Z]+)\s+(\d+)\s+(.+)$/', $line, $m)) continue;
		$name = trim($m[1]);
		if ($name === '.' || $name === '..') continue;

		$attrs		= $m[2];
		$size		= (int)$m[3];
		$dateStr	= trim($m[4]);
		$isDir		= str_contains($attrs, 'D');
		$isHidden	= str_contains($attrs, 'H');
		$isRO		= str_contains($attrs, 'R');

		$modified = null;
		$ts = strtotime($dateStr);
		if ($ts !== false) {
			$modified = date('c', $ts); // ISO 8601
		}

		$ext = null;
		if (!$isDir) {
			$ext = strtolower(pathinfo($name, PATHINFO_EXTENSION)) ?: null;
		}

		$entries[] = [
			'name'		=> $name,
			'type'		=> $isDir ? 'folder' : 'file',
			'ext'		=> $ext,
			'size'		=> $isDir ? null : $size,
			'modified'	=> $modified,
			'hidden'	=> $isHidden,
			'readonly'	=> $isRO,
		];
	}
	return $entries;
}

// ── ROUTING ──────────────────────────────────────────────────────────────────

$method = $_SERVER['REQUEST_METHOD'];
$uri	= parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$uri	= '/' . ltrim($uri, '/');
$uri = $_SERVER['PATH_INFO'];
// Strip a base path if running in a subdirectory (e.g. /netshare/api.php)
// Normalise to always start with /api/
if (!str_starts_with($uri, '/api/')) {
	// Running as /api.php?... or similar — rewrite for the router
	$uri = '/api/' . ltrim(preg_replace('#^/[^/]+\.php#', '', $uri), '/');
}
//file_put_contents('URI.txt',print_r($_SERVER,true)."$uri\n",FILE_APPEND);
$body = [];
if (in_array($method, ['POST', 'DELETE', 'PATCH'])) {
	$raw = file_get_contents('php://input');
	if ($raw !== '') $body = json_decode($raw, true) ?? [];
}

/**
 * Simple router: match $method + $uri pattern, call handler.
 */
function route(string $m, string $pattern, callable $handler): bool {
	global $method, $uri;
	if ($method !== $m) return false;
	$regex = '#^' . preg_replace('#\{([^}]+)\}#', '(?P<$1>[a-f0-9\-]+)', $pattern) . '$#';
	if (!preg_match($regex, $uri, $matches)) return false;
	$params = array_filter($matches, 'is_string', ARRAY_FILTER_USE_KEY);
	$handler($params);
	return true;
}

function jsonOut(mixed $data, int $status = 200): void {
	http_response_code($status);
	echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
	exit;
}

function jsonErr(string $msg, int $status = 500): void {
	jsonOut(['error' => $msg], $status);
}

function requireSession(string $id): array {
	$sess = sessionLoad($id);
	if (!$sess) jsonErr('Session not found or expired. Please reconnect.', 401);
	return sessionTouch($id, $sess);
}

// ── HEALTH ───────────────────────────────────────────────────────────────────
if (route('GET', '/api/health', function() {
	$smbclient = (shell_exec('which smbclient') !== null);
	$count = count(glob(SESSION_DIR . '/*.json') ?: []);
	jsonOut([
		'status'	=> 'ok',
		'sessions'	=> $count,
		'smbclient' => $smbclient,
		'php'		=> PHP_VERSION,
		'uptime'	=> (int)(microtime(true) - $_SERVER['REQUEST_TIME_FLOAT']),
	]);
})) exit;

// ── CONNECT ───────────────────────────────────────────────────────────────────
if (route('POST', '/api/connect', function() use ($body) {
	$host		= trim($body['host'] ?? '');
	$share		= trim($body['share'] ?? '');
	$username	= trim($body['username'] ?? 'guest');
	$password	= $body['password'] ?? '';
	$domain		= trim($body['domain'] ?? 'WORKGROUP');
	$port		= (int)($body['port'] ?? 445);

	if ($host === '' || $share === '') {
		jsonErr('`host` and `share` are required.', 400);
	}

	// Check smbclient is available
	if (shell_exec('which smbclient') === null) {
		jsonErr('`smbclient` not found. Install: sudo apt install samba-client', 500);
	}

	$cfg = compact('host', 'port', 'share', 'username', 'password', 'domain');

	try {
		smbCmd($cfg, 'ls');
	} catch (RuntimeException $e) {
		jsonErr($e->getMessage(), 502);
	}

	$id = sprintf(
		'%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
		mt_rand(0, 0xffff), mt_rand(0, 0xffff),
		mt_rand(0, 0xffff),
		mt_rand(0, 0x0fff) | 0x4000,
		mt_rand(0, 0x3fff) | 0x8000,
		mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)
	);

	sessionSave($id, array_merge($cfg, [
		'created'	 => time(),
		'lastAccess' => time(),
	]));

	jsonOut(['sessionId' => $id, 'message' => "Connected to //{$host}/{$share}"]);
})) exit;

// ── DISCONNECT ────────────────────────────────────────────────────────────────
if (route('DELETE', '/api/connect/{id}', function(array $p) {
	sessionDelete($p['id']);
	jsonOut(['message' => 'Disconnected.']);
})) exit;

// ── LIST DIRECTORY ────────────────────────────────────────────────────────────
if (route('GET', '/api/files/{id}', function(array $p) {
	// Don't intercept /download sub-route
	if (str_ends_with($p['id'], '/download') || isset($_GET['_download'])) return;

	$sess	 = requireSession($p['id']);
	$dirPath = trim($_GET['path'] ?? '', '/');
	$dirPath = str_replace('/', '\\', $dirPath);
	$cdCmd	 = $dirPath !== '' ? "cd \"{$dirPath}\";" : '';

	try {
		$stdout	 = smbCmd($sess, "{$cdCmd} ls");
		$entries = parseLs($stdout);
		jsonOut(['path' => $dirPath ?: '/', 'entries' => $entries]);
	} catch (RuntimeException $e) {
		jsonErr($e->getMessage());
	}
})) exit;

// ── DOWNLOAD ──────────────────────────────────────────────────────────────────
if (route('GET', '/api/files/{id}/download', function(array $p) {
	// id here contains "{uuid}/download" — extract real id
	$realId = str_replace('/download', '', $p['id']);
})) exit;

// The router above won't cleanly capture nested paths, so handle download manually:
if ($method === 'GET' && preg_match('#^/api/files/([a-f0-9\-]{36})/download$#', $uri, $m)) {
	$sess		= requireSession($m[1]);
	$remotePath = trim($_GET['path'] ?? '', '/');
	if ($remotePath === '') jsonErr('`path` query parameter required.', 400);

	$fileName	= basename($remotePath);
	$remoteDir	= dirname($remotePath);
	$remoteName = $fileName;
	$cdCmd		= ($remoteDir && $remoteDir !== '.') ? 'cd "' . str_replace('/', '\\', $remoteDir) . '";' : '';

	$tmpFile = tempnam(sys_get_temp_dir(), 'netshare_dl_');

	try {
		smbCmd($sess, "{$cdCmd} get \"{$remoteName}\" \"{$tmpFile}\"");
	} catch (RuntimeException $e) {
		@unlink($tmpFile);
		jsonErr($e->getMessage());
	}

	if (!file_exists($tmpFile) || filesize($tmpFile) === 0) {
		@unlink($tmpFile);
		jsonErr('Download failed or file is empty.');
	}

	header('Content-Type: application/octet-stream');
	header('Content-Disposition: attachment; filename="' . rawurlencode($fileName) . '"');
	header('Content-Length: ' . filesize($tmpFile));
	header('Cache-Control: no-store');
	// Remove JSON content-type set at top
	header_remove('Content-Type');
	header('Content-Type: application/octet-stream');

	readfile($tmpFile);
	@unlink($tmpFile);
	exit;
}

// ── UPLOAD ────────────────────────────────────────────────────────────────────
if ($method === 'POST' && preg_match('#^/api/files/([a-f0-9\-]{36})/upload$#', $uri, $m)) {
	$sess	 = requireSession($m[1]);
	$dirPath = str_replace('/', '\\', trim($_GET['path'] ?? '', '/'));

	if (empty($_FILES['files'])) {
		jsonErr('No files received.', 400);
	}
//file_put_contents('FILES.txt',print_r($_FILES['files'],true),FILE_APPEND);
	// Normalise $_FILES['files'] to always be an array of individual files
	$files = $_FILES['files'];
	if (!is_array($files['name'])) {
	//	$files = array_map(fn($k) => array_column([$files], $k)[0], array_keys($files));
		$files = [$files];
	} else {
		$count = count($files['name']);
		$files = array_map(fn($i) => [
			'name'		=> $files['name'][$i],
			'tmp_name'	=> $files['tmp_name'][$i],
			'size'		=> $files['size'][$i],
			'error'		=> $files['error'][$i],
		], range(0, $count - 1));
	}
//file_put_contents('FILES.txt',print_r($files,true),FILE_APPEND);

	$results = [];
	foreach ($files as $file) {
		if ($file['error'] !== UPLOAD_ERR_OK) {
			$results[] = ['name' => $file['name'], 'status' => 'error', 'error' => 'Upload error code ' . $file['error']];
			continue;
		}
		$remoteName = basename($file['name']);
		$cdCmd		= $dirPath !== '' ? "cd \"{$dirPath}\";" : '';
		try {
			smbCmd($sess, "{$cdCmd} put \"{$file['tmp_name']}\" \"{$remoteName}\"");
			$results[] = ['name' => $file['name'], 'status' => 'ok', 'size' => $file['size']];
		} catch (RuntimeException $e) {
			$results[] = ['name' => $file['name'], 'status' => 'error', 'error' => $e->getMessage()];
		}
	}

	$failed = array_filter($results, fn($r) => $r['status'] === 'error');
	$status = count($failed) === 0 ? 200 : (count($failed) < count($results) ? 207 : 500);
	jsonOut(['results' => $results], $status);
}

// ── MKDIR ─────────────────────────────────────────────────────────────────────
if ($method === 'POST' && preg_match('#^/api/files/([a-f0-9\-]{36})/mkdir$#', $uri, $m)) {
	$sess	 = requireSession($m[1]);
	$dirPath = str_replace('/', '\\', ltrim($body['path'] ?? '', '/'));
	if ($dirPath === '') jsonErr('`path` is required.', 400);

	try {
		smbCmd($sess, "mkdir \"{$dirPath}\"");
		jsonOut(['message' => "Directory created: {$dirPath}"]);
	} catch (RuntimeException $e) {
		jsonErr($e->getMessage());
	}
}

// ── DELETE ────────────────────────────────────────────────────────────────────
if ($method === 'DELETE' && preg_match('#^/api/files/([a-f0-9\-]{36})$#', $uri, $m)) {
	$sess = requireSession($m[1]);
	$target = str_replace('/', '\\', ltrim($body['path'] ?? '', '/'));
	$recursive = !empty($body['recursive']);
	if ($target === '') jsonErr('`path` is required.', 400);

	try {
		if ($recursive) {
			smbCmd($sess, "deltree \"{$target}\"");
		} else {
			try {
				smbCmd($sess, "del \"{$target}\"");
			} catch (RuntimeException $e) {
				smbCmd($sess, "rmdir \"{$target}\"");
			}
		}
		jsonOut(['message' => "Deleted: {$target}"]);
	} catch (RuntimeException $e) {
		jsonErr($e->getMessage());
	}
}

// ── RENAME ────────────────────────────────────────────────────────────────────
if ($method === 'PATCH' && preg_match('#^/api/files/([a-f0-9\-]{36})/rename$#', $uri, $m)) {
	$sess = requireSession($m[1]);
	$from = str_replace('/', '\\', ltrim($body['from'] ?? '', '/'));
	$to = str_replace('/', '\\', ltrim($body['to'] ?? '', '/'));
	if ($from === '' || $to === '') jsonErr('`from` and `to` are required.', 400);

	try {
		smbCmd($sess, "rename \"{$from}\" \"{$to}\"");
		jsonOut(['message' => "Renamed: {$from} → {$to}"]);
	} catch (RuntimeException $e) {
		jsonErr($e->getMessage());
	}
}

// ── 404 ───────────────────────────────────────────────────────────────────────
jsonErr('Not found.', 404);
