import sys, struct
def walk(b, s, e, path=''):
    o = s
    while o + 8 <= e:
        size, t = struct.unpack('>I4s', b[o:o+8]); t = t.decode('latin1'); h = 8
        if size == 1: size = struct.unpack('>Q', b[o+8:o+16])[0]; h = 16
        if size == 0: size = e - o
        if t in ('moov','trak','edts','mdia','minf','stbl'): walk(b, o+h, o+size, path+'/'+t)
        if t == 'elst':
            v = b[o+h]; n = struct.unpack('>I', b[o+h+4:o+h+8])[0]; p = o+h+8; ents=[]
            for i in range(n):
                if v == 1: d, m = struct.unpack('>Qq', b[p:p+16]); p += 20
                else: d, m = struct.unpack('>Ii', b[p:p+8]); p += 12
                ents.append((d, m))
            print(' ', path, 'elst', ents)
        if t in ('mdhd','mvhd'):
            v = b[o+h]; ts = struct.unpack('>I', b[o+h+(20 if v else 12):o+h+(24 if v else 16)])[0]; print(' ', path, t, 'timescale', ts)
        o += size
for f in sys.argv[1:]:
    print(f); b = open(f,'rb').read(); walk(b, 0, len(b))
