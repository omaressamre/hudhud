import http.server, socketserver, sys, os, urllib.parse
os.chdir(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.mp4':'video/mp4', '.m3u8':'application/vnd.apple.mpegurl', '.ts':'video/mp2t', '.key':'application/octet-stream'}
    def log_message(self,*a): pass
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*'); super().end_headers()
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        if u.path == '/watch' or u.path.startswith('/shorts/'):
            vid = q.get('v', [u.path.split('/')[-1]])[0]
            html = f'<!doctype html><html><head><meta charset="utf-8"><title>Video {vid} - YouTube</title></head><body><h1>{vid}</h1></body></html>'.encode()
            self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Content-Length', str(len(html))); self.end_headers(); self.wfile.write(html); return
        if 'bytestart' in q:
            data = open('.' + u.path, 'rb').read()
            s, e = int(q['bytestart'][0]), int(q.get('byteend', [len(data)-1])[0])
            chunk = data[s:e+1]
            self.send_response(200); self.send_header('Content-Type', 'video/mp4'); self.send_header('Content-Length', str(len(chunk))); self.end_headers(); self.wfile.write(chunk); return
        rng = self.headers.get('Range')
        path = '.' + u.path
        if rng and os.path.isfile(path):
            data = open(path,'rb').read(); a, _, b = rng.replace('bytes=','').partition('-')
            a = int(a or 0); b = int(b) if b else len(data)-1; chunk = data[a:b+1]
            self.send_response(206); self.send_header('Content-Type', self.guess_type(path)); self.send_header('Accept-Ranges','bytes')
            self.send_header('Content-Range', f'bytes {a}-{a+len(chunk)-1}/{len(data)}'); self.send_header('Content-Length', str(len(chunk))); self.end_headers(); self.wfile.write(chunk); return
        return super().do_GET()
socketserver.ThreadingTCPServer.allow_reuse_address=True
socketserver.ThreadingTCPServer(('127.0.0.1',8765),H).serve_forever()
