set -e
F="ffmpeg -hide_banner -loglevel error -y"
H="-f hls -hls_time 2 -hls_playlist_type vod"
mk(){ rm -rf $1; mkdir -p $1; }
# t2: baseline بدون B-frames، 30fps، صوت mono 44.1k
mk t2; $F -f lavfi -i testsrc=size=426x240:rate=30 -f lavfi -i sine=f=300:sample_rate=44100 -t 9 -c:v libx264 -profile:v baseline -pix_fmt yuv420p -c:a aac -ac 1 -shortest $H t2/index.m3u8
# t3: الصوت بيبدأ متأخر 0.7 ثانية عن الصورة
mk t3; $F -f lavfi -i testsrc2=size=640x360:rate=25 -itsoffset 0.7 -f lavfi -i sine=f=600:sample_rate=48000 -t 8 -c:v libx264 -bf 2 -pix_fmt yuv420p -c:a aac $H t3/index.m3u8
# t4: فيديو بس
mk t4; $F -f lavfi -i testsrc2=size=640x360:rate=24 -t 7 -c:v libx264 -bf 3 -pix_fmt yuv420p $H t4/index.m3u8
# t5: صوت بس AAC
mk t5; $F -f lavfi -i sine=f=500:sample_rate=44100 -t 7 -c:a aac $H t5/index.m3u8
# t6: صوت MP3
mk t6; $F -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=f=700:sample_rate=44100 -t 8 -c:v libx264 -pix_fmt yuv420p -c:a libmp3lame -b:a 128k -shortest $H t6/index.m3u8
# t7: HEVC (لازم يرفض)
mk t7; $F -f lavfi -i testsrc2=size=640x360:rate=25 -t 4 -c:v libx265 -x265-params log-level=none -pix_fmt yuv420p $H t7/index.m3u8
# t8: AC-3 (لازم يرفض)
mk t8; $F -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=f=700 -t 4 -c:v libx264 -pix_fmt yuv420p -c:a ac3 -shortest $H t8/index.m3u8
# t9: لفة العدّاد (33 بت) في النص
mk t9; $F -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=f=500:sample_rate=48000 -t 8 -c:v libx264 -bf 2 -pix_fmt yuv420p -c:a aac -shortest -output_ts_offset 95440.5 -f mpegts t9/a.ts
printf '#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXTINF:8,\na.ts\n#EXT-X-ENDLIST\n' > t9/index.m3u8
# t11: 5.1
mk t11; $F -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i "sine=f=300:sample_rate=48000" -t 6 -filter_complex "[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]" -map 0:v -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $H t11/index.m3u8
# t13: بكسلات مش مربعة (anamorphic)
mk t13; $F -f lavfi -i testsrc2=size=720x576:rate=25 -f lavfi -i sine=f=500 -t 5 -vf setsar=16/15 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $H t13/index.m3u8
# t15: 23.976 + B-pyramid + high 10 frames
mk t15; $F -f lavfi -i testsrc2=size=1280x720:rate=24000/1001 -f lavfi -i sine=f=400:sample_rate=48000 -t 10 -c:v libx264 -profile:v high -bf 3 -b_strategy 2 -x264-params b-pyramid=normal:keyint=48 -pix_fmt yuv420p -c:a aac -shortest $H t15/index.m3u8
# t16: 4:2:2 high profile (SPS بـchroma_format)
mk t16; $F -f lavfi -i testsrc2=size=640x360:rate=25 -t 4 -c:v libx264 -profile:v high422 -pix_fmt yuv422p $H t16/index.m3u8
# t17: ارتفاع مش من مضاعفات 16 (cropping)
mk t17; $F -f lavfi -i testsrc2=size=854x478:rate=25 -f lavfi -i sine=f=500 -t 4 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $H t17/index.m3u8
