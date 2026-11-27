package main

import "testing"

func ip(n int) *int { return &n }

func TestEstimateSizes(t *testing.T) {
	formats := []ytFormat{
		{Acodec: "mp4a.40.2", Vcodec: "none", Ext: "m4a", Filesize: 2_000_000, Tbr: 128},
		{Acodec: "opus", Vcodec: "none", Ext: "webm", Filesize: 1_800_000, Tbr: 140},
		{Height: ip(1080), Vcodec: "avc1", Acodec: "none", Ext: "mp4", Filesize: 50_000_000, Tbr: 3000},
		{Height: ip(1080), Vcodec: "vp9", Acodec: "none", Ext: "webm", Filesize: 40_000_000, Tbr: 3500},
		{Height: ip(2160), Vcodec: "vp9", Acodec: "none", Ext: "webm", FilesizeApprox: 300_000_000, Tbr: 18000},
		{Height: ip(720), Vcodec: "avc1", Acodec: "none", Ext: "mp4", Tbr: 1500},
		{Height: ip(360), Vcodec: "avc1", Acodec: "mp4a.40.2", Ext: "mp4", Filesize: 9_000_000, Tbr: 600},
	}
	sizes, audio := estimateSizes(formats, 100)
	check := func(h int, want int64, approx bool) {
		t.Helper()
		s := sizes[h]
		if s["bytes"] != want || s["approx"] != approx {
			t.Errorf("%dp: got %v %v, want %d %v", h, s["bytes"], s["approx"], want, approx)
		}
	}
	check(1080, 52_000_000, false)         // the mp4 one (as -S ext:mp4 picks) + m4a audio
	check(2160, 302_000_000, true)         // only webm exists; yt-dlp's estimate
	check(720, 18_750_000+2_000_000, true) // from bitrate: 1500 kb/s × 100 s
	check(360, 9_000_000, false)           // has its own audio: nothing added
	if audio["m4a"] != int64(2_000_000) || audio["mp3"] != int64(3_062_500) {
		t.Errorf("audio: %v", audio)
	}
	if s, a := estimateSizes(nil, 0); len(s) != 0 || a["m4a"] != int64(0) {
		t.Errorf("empty: %v %v", s, a)
	}
}
