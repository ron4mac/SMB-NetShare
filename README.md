# SMB-NetShare
This Web Application provides browser access to SMB shares. Multiple shares can be open simultaneously. Leveraging _smbclient_, it provides a number of simple functions ... download, upload, new folder, delete, rename.

It requires a web server (apache2, nginx, lighttpd) with _smbclient_ installed. Place it in a directory off the document root of the server. It may be preferable to password protect the directory.

![NetShare](https://github.com/user-attachments/assets/4a2b905f-b325-4615-acb2-15146829f8de)
