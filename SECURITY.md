# Security

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue.

Areas we care most about:

- the native-messaging helper (`helper/`): it runs local processes, so any way for a web page to influence its command line, output path or the files it opens is serious;
- the extension's message handlers, which must only accept messages from the extension itself;
- the installers, which download third-party binaries.

The helper only accepts connections from the extension ID pinned in the manifest (`allowed_origins`), passes arguments to yt-dlp/ffmpeg as an argv list (never through a shell), and writes only inside the download folder you chose.
