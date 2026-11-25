set -e
F="ffmpeg -hide_banner -loglevel error -y"
V="-f lavfi -i testsrc2=size=640x360:rate=30 -t 8"
A="-f lavfi -i sine=f=440:sample_rate=48000 -t 8"
FRAG="-movflags +frag_keyframe+empty_moov+default_base_moof"
mkdir -p c && cd c
# 1) زي فيسبوك: fragmented + default-base-moof، B-frames
$F $V -c:v libx264 -bf 3 -g 30 -pix_fmt yuv420p $FRAG fb_v.mp4
$F $A -c:a aac -b:a 96k $FRAG fb_a.mp4
# 2) fragmented من غير default-base-moof (base_data_offset صريح)
$F $V -c:v libx264 -bf 2 -g 30 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov nb_v.mp4
$F $A -c:a aac -movflags +frag_keyframe+empty_moov nb_a.mp4
# 3) DASH بـsidx (زي ملفات انستجرام)
$F $V -c:v libx264 -bf 2 -g 30 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx -frag_duration 1000000 sx_v.mp4
$F $A -c:a aac -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx -frag_duration 1000000 sx_a.mp4
# 4) MP4 عادي faststart
$F $V -c:v libx264 -bf 3 -pix_fmt yuv420p -movflags +faststart fs_v.mp4
$F $A -c:a aac -movflags +faststart fs_a.mp4
# 5) MP4 عادي moov في الآخر (لازم Range)
$F $V -c:v libx264 -bf 3 -pix_fmt yuv420p me_v.mp4
$F $A -c:a aac me_a.mp4
# 6) VP9 + Opus
$F $V -c:v libvpx-vp9 -b:v 500k -deadline realtime -cpu-used 8 $FRAG vp_v.mp4
$F $A -c:a libopus -b:a 96k $FRAG vp_a.mp4
# 7) negative CTS (trun version 1) من غير edit list
$F $V -c:v libx264 -bf 3 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets ng_v.mp4
cp fb_a.mp4 ng_a.mp4
# 8) الصوت بيبدأ بعد الصورة بنص ثانية
$F $V -c:v libx264 -pix_fmt yuv420p $FRAG lt_v.mp4
$F -itsoffset 0.5 $A -c:a aac $FRAG lt_a.mp4
# 9) fragments صغيرة جداً (كتير)
$F $V -c:v libx264 -bf 2 -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 100000 sm_v.mp4
$F $A -c:a aac -movflags +frag_keyframe+empty_moov+default_base_moof -frag_duration 100000 sm_a.mp4
# 10) AV1
$F -f lavfi -i testsrc2=size=320x240:rate=24 -t 4 -c:v libsvtav1 -preset 12 $FRAG av_v.mp4 2>/dev/null || true
$F -f lavfi -i sine=f=300:sample_rate=48000 -t 4 -c:a aac $FRAG av_a.mp4
# 11) mixed: صورة fragmented + صوت عادي moov في الآخر
cp fb_v.mp4 mx_v.mp4; cp me_a.mp4 mx_a.mp4
