// Hudhud Helper: برنامج Native Messaging بيستقبل أوامر من الإضافة ويشغّل yt-dlp و ffmpeg.
//
// البروتوكول: كل رسالة = 4 بايت طول (little-endian) + JSON.
//
//	ext → host: {id, cmd: ping|config|download|merge|cancel|probe|reveal|openDir|chooseFolder|update|selfUpdate, ...}
//	host → ext: {id, ok, ...}                                   رد على الأمر
//	            {jobId, event: queued|started|progress|done|error|canceled, ...}
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const Version = "0.9.9"

type Req struct {
	ID        string `json:"id"`
	Cmd       string `json:"cmd"`
	JobID     string `json:"jobId"`
	URL       string `json:"url"`
	AudioURL  string `json:"audioUrl"`
	Referer   string `json:"referer"`
	UserAgent string `json:"userAgent"`
	Height    int    `json:"height"`
	AudioOnly bool   `json:"audioOnly"`
	BaseDir   string `json:"baseDir"`
	RelDir    string `json:"relDir"`
	Name      string `json:"name"`
	Cookies   string `json:"cookies"`
	File      string `json:"file"`

	Playlist    bool   `json:"playlist"`
	Subs        bool   `json:"subs"`
	SubLangs    string `json:"subLangs"`
	AudioFormat string `json:"audioFormat"` // "" | mp3 | m4a
	EmbedMeta   bool   `json:"embedMeta"`
	EmbedThumb  bool   `json:"embedThumb"`
	RateLimit   string `json:"rateLimit"`

	MaxConcurrent int    `json:"maxConcurrent"`
	HelperOnly    bool   `json:"helperOnly"` // selfUpdate: replace only the helper (Firefox updates the extension itself)
	Lang          string `json:"lang"`
	AutoUpdate    bool   `json:"autoUpdate"`
}

type job struct {
	mu       sync.Mutex
	cmd      *exec.Cmd
	canceled bool
}

func (j *job) isCanceled() bool { j.mu.Lock(); defer j.mu.Unlock(); return j.canceled }

var (
	outMu  sync.Mutex
	exeDir string
	jobsMu sync.Mutex
	jobs   = map[string]*job{}
	wg     sync.WaitGroup
	lim    = newLimiter(3)
)

// ───────────── طابور التحميل ─────────────

type limiter struct {
	mu       sync.Mutex
	cond     *sync.Cond
	max, cur int
}

func newLimiter(n int) *limiter {
	l := &limiter{max: n}
	l.cond = sync.NewCond(&l.mu)
	return l
}

func (l *limiter) activeCount() int { l.mu.Lock(); defer l.mu.Unlock(); return l.cur }

func (l *limiter) busy() bool { l.mu.Lock(); defer l.mu.Unlock(); return l.cur >= l.max }

func (l *limiter) acquire(canceled func() bool, onWait func()) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	waited := false
	for l.cur >= l.max && !canceled() {
		if !waited {
			waited = true
			onWait()
		}
		l.cond.Wait()
	}
	if canceled() {
		return false
	}
	l.cur++
	return true
}

func (l *limiter) release() { l.mu.Lock(); l.cur--; l.mu.Unlock(); l.cond.Broadcast() }

func (l *limiter) setMax(n int) {
	if n < 1 {
		n = 1
	}
	if n > 10 {
		n = 10
	}
	l.mu.Lock()
	l.max = n
	l.mu.Unlock()
	l.cond.Broadcast()
}

// ───────────── التواصل مع المتصفح ─────────────

func send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		log.Println("marshal:", err)
		return
	}
	outMu.Lock()
	defer outMu.Unlock()
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(b)))
	os.Stdout.Write(hdr[:])
	os.Stdout.Write(b)
}

func reply(id string, data map[string]any) {
	m := map[string]any{"id": id, "ok": true}
	for k, v := range data {
		m[k] = v
	}
	send(m)
}

func replyErr(id string, err error) {
	send(map[string]any{"id": id, "ok": false, "error": err.Error()})
}

func event(jobID, name string, data map[string]any) {
	m := map[string]any{"jobId": jobID, "event": name}
	for k, v := range data {
		m[k] = v
	}
	send(m)
}

func readMsg(r io.Reader) (*Req, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(hdr[:])
	if n > 64<<20 {
		return nil, errors.New("message too large")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	var q Req
	if err := json.Unmarshal(buf, &q); err != nil {
		return nil, err
	}
	return &q, nil
}

func main() {
	exe, _ := os.Executable()
	exeDir = filepath.Dir(exe)
	logPath := filepath.Join(exeDir, "helper.log")
	if st, err := os.Stat(logPath); err == nil && st.Size() > 2<<20 {
		os.Remove(logPath)
	}
	if lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
		log.SetOutput(lf)
	} else {
		log.SetOutput(io.Discard)
	}
	log.Printf("start v%s args=%q", Version, os.Args[1:])
	cleanupOldUpdate()

	in := bufio.NewReader(os.Stdin)
	for {
		q, err := readMsg(in)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Println("read:", err)
			}
			break
		}
		go handle(q)
	}
	// المتصفح قفل الاتصال: نسيب التحميلات الشغالة تكمّل
	wg.Wait()
	log.Println("exit")
}

func handle(q *Req) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic: %v", r)
			replyErr(q.ID, fmt.Errorf("internal error: %v", r))
		}
	}()
	switch q.Cmd {
	case "ping":
		reply(q.ID, info())
	case "config":
		if q.MaxConcurrent > 0 {
			lim.setMax(q.MaxConcurrent)
		}
		if q.Lang != "" {
			setLang(q.Lang)
		}
		if q.AutoUpdate {
			go maybeAutoUpdate()
		}
		reply(q.ID, nil)
	case "download", "merge":
		dir, queued, err := enqueue(q)
		if err != nil {
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, map[string]any{"jobId": q.JobID, "dir": dir, "queued": queued})
	case "cancel":
		cancelJob(q.JobID)
		reply(q.ID, nil)
	case "active":
		// jobs this helper is running or queueing: the extension drops "running" entries that aren't here
		jobsMu.Lock()
		ids := make([]string, 0, len(jobs))
		for id := range jobs {
			ids = append(ids, id)
		}
		jobsMu.Unlock()
		reply(q.ID, map[string]any{"jobs": ids})
	case "probe":
		res, err := probe(q)
		if err != nil {
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, res)
	case "reveal":
		target := q.File
		if target == "" {
			replyErr(q.ID, errors.New("no file"))
			return
		}
		st, err := os.Stat(target)
		if err != nil {
			replyErr(q.ID, errors.New(tr("الملف مش موجود", "file not found")))
			return
		}
		if err := revealPath(target, st.IsDir()); err != nil {
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, nil)
	case "openFile":
		// play a finished download with the system's default app
		st, err := os.Stat(q.File)
		if q.File == "" || err != nil || st.IsDir() {
			replyErr(q.ID, errors.New(tr("الملف مش موجود", "file not found")))
			return
		}
		if err := openFolder(q.File); err != nil { // open/xdg-open/explorer open files with their default app too
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, nil)
	case "space":
		// free space where the download will be saved (the nearest folder that exists)
		dir := filepath.Join(resolveBase(q.BaseDir), cleanRel(q.RelDir))
		for {
			if st, err := os.Stat(dir); err == nil && st.IsDir() {
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
		free, err := freeBytes(dir)
		if err != nil {
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, map[string]any{"free": free, "dir": dir})
	case "openDir":
		dir := resolveBase(q.BaseDir)
		os.MkdirAll(dir, 0o755)
		if err := openFolder(dir); err != nil {
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, nil)
	case "chooseFolder":
		p, err := chooseFolder()
		if err != nil {
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, map[string]any{"path": p})
	case "selfUpdate":
		if lim.activeCount() > 0 {
			replyErr(q.ID, errors.New(tr("استنى التحميلات تخلص الأول", "wait for the downloads to finish first")))
			return
		}
		res, err := selfUpdate(q.HelperOnly)
		if err != nil {
			log.Println("self-update:", err)
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, res)
	case "update":
		out, err := updateYtdlp()
		if err != nil {
			replyErr(q.ID, err)
			return
		}
		reply(q.ID, map[string]any{"output": out, "ytdlp": ytdlpVersion()})
	default:
		replyErr(q.ID, fmt.Errorf("unknown cmd %q", q.Cmd))
	}
}

// ───────────── الأدوات ─────────────

func tool(name string) string {
	exe := name
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	p := filepath.Join(exeDir, exe)
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return p
	}
	if lp, err := exec.LookPath(name); err == nil {
		return lp
	}
	return ""
}

var (
	verMu  sync.Mutex
	verVal string
)

func ytdlpVersion() string {
	verMu.Lock()
	defer verMu.Unlock()
	if verVal != "" {
		return verVal
	}
	yt := tool("yt-dlp")
	if yt == "" {
		return ""
	}
	out, err := runCapture(20*time.Second, yt, "--version")
	if err != nil {
		return ""
	}
	verVal = strings.TrimSpace(out)
	return verVal
}

func resetVersion() { verMu.Lock(); verVal = ""; verMu.Unlock() }

func info() map[string]any {
	lim.mu.Lock()
	active, max := lim.cur, lim.max
	lim.mu.Unlock()
	return map[string]any{
		"version":       Version,
		"ytdlp":         ytdlpVersion(),
		"ffmpeg":        tool("ffmpeg") != "",
		"deno":          tool("deno") != "",
		"defaultDir":    defaultDir(),
		"os":            runtime.GOOS,
		"active":        active,
		"maxConcurrent": max,
		"installId":     installID(),
		"extDir":        managedExtensionDir(),
		"extVersion":    managedExtensionVersion(),
	}
}

var updateMu sync.Mutex

func updateYtdlp() (string, error) {
	updateMu.Lock()
	defer updateMu.Unlock()
	yt := tool("yt-dlp")
	if yt == "" {
		return "", errors.New(tr("yt-dlp مش موجود", "yt-dlp is missing"))
	}
	out, err := runCapture(3*time.Minute, yt, "-U", "--encoding", "utf-8")
	resetVersion()
	os.WriteFile(filepath.Join(exeDir, ".last-update"), []byte(time.Now().Format(time.RFC3339)), 0o644)
	if err != nil {
		return "", fmt.Errorf("%v: %s", err, lastLines(out, 3))
	}
	return lastLines(out, 3), nil
}

// تحديث yt-dlp لوحده مرة كل يوم، بس لو مفيش تحميل شغال
func maybeAutoUpdate() {
	stamp := filepath.Join(exeDir, ".last-update")
	if st, err := os.Stat(stamp); err == nil && time.Since(st.ModTime()) < 24*time.Hour {
		return
	}
	lim.mu.Lock()
	busy := lim.cur > 0
	lim.mu.Unlock()
	if busy {
		return
	}
	out, err := updateYtdlp()
	log.Printf("auto-update: %v %s", err, out)
}

func runCapture(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8", "PYTHONUTF8=1")
	hideWindow(cmd)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := cmd.Run()
	return buf.String(), err
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(strings.ReplaceAll(s, "\r", "")), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

// ───────────── المسارات والأسماء ─────────────

func defaultDir() string {
	if d := platformDownloads(); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return exeDir
	}
	return filepath.Join(home, "Downloads")
}

func resolveBase(base string) string {
	if base != "" && filepath.IsAbs(base) {
		return filepath.Clean(base)
	}
	return defaultDir()
}

var badChars = strings.NewReplacer("<", " ", ">", " ", ":", " ", `"`, " ", "/", " ", `\`, " ", "|", " ", "?", " ", "*", " ")

func cleanSegment(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, s)
	s = badChars.Replace(s)
	s = strings.Join(strings.Fields(s), " ")
	s = strings.Trim(s, ". ")
	switch strings.ToUpper(s) {
	case "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
		"LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9":
		s = "_" + s
	}
	return s
}

// مسار فرعي آمن: ما يطلعش برّه الفولدر الأساسي
func cleanRel(rel string) string {
	var parts []string
	for _, p := range strings.FieldsFunc(rel, func(r rune) bool { return r == '/' || r == '\\' }) {
		p = cleanSegment(p)
		if p == "" || p == "." || p == ".." {
			continue
		}
		parts = append(parts, p)
	}
	return filepath.Join(parts...)
}

func uniquePath(p string) string {
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(p)
	base := strings.TrimSuffix(p, ext)
	for i := 1; i < 1000; i++ {
		c := fmt.Sprintf("%s (%d)%s", base, i, ext)
		if _, err := os.Stat(c); err != nil {
			return c
		}
	}
	return p
}

func validURL(u string) bool {
	return strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://")
}

func writeCookies(text string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", nil
	}
	f, err := os.CreateTemp("", "hudhud-cookies-*.txt")
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.WriteString(text); err != nil {
		os.Remove(f.Name())
		return "", err
	}
	return f.Name(), nil
}

// ───────────── تجهيز أوامر yt-dlp ─────────────

func formatFor(q *Req) string {
	if q.AudioOnly || q.AudioFormat != "" {
		if q.AudioFormat == "m4a" {
			return "ba[ext=m4a]/ba/b"
		}
		return "ba/b"
	}
	if q.Height > 0 {
		return fmt.Sprintf("bv*[height<=%d]+ba/b[height<=%d]/bv*+ba/b", q.Height, q.Height)
	}
	return "bv*+ba/b"
}

func commonArgs(q *Req, cookieFile string) []string {
	args := []string{"--no-color", "--encoding", "utf-8"}
	if q.Playlist {
		args = append(args, "--yes-playlist")
	} else {
		args = append(args, "--no-playlist")
	}
	if q.UserAgent != "" {
		args = append(args, "--user-agent", q.UserAgent)
	}
	if q.Referer != "" {
		args = append(args, "--add-header", "Referer:"+q.Referer)
	}
	if cookieFile != "" {
		args = append(args, "--cookies", cookieFile)
	}
	if ff := tool("ffmpeg"); ff != "" {
		args = append(args, "--ffmpeg-location", filepath.Dir(ff))
	}
	// يوتيوب بقى محتاج JavaScript runtime خارجي (Deno) عشان يحل الـchallenges
	if deno := tool("deno"); deno != "" {
		args = append(args, "--js-runtimes", "deno:"+deno)
	}
	return args
}

var rateRe = regexp.MustCompile(`^\d+(\.\d+)?[KkMm]?$`)

const progressTpl = "download:VS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(info.playlist_index)s|%(info.n_entries)s"

func ytdlpArgs(q *Req, outDir, name, cookieFile string) []string {
	args := commonArgs(q, cookieFile)
	args = append(args,
		"--newline", "--progress", "--no-mtime",
		"--concurrent-fragments", "4", "--retries", "10", "--fragment-retries", "10",
		"--progress-template", progressTpl,
		"--print", "after_move:VSFILE %(filepath)s",
		"--print", "before_dl:VSTITLE %(title)s",
		"-f", formatFor(q),
	)
	audio := q.AudioOnly || q.AudioFormat != ""
	switch {
	case q.AudioFormat == "mp3":
		args = append(args, "-x", "--audio-format", "mp3", "--audio-quality", "0")
	case q.AudioFormat == "m4a" || q.AudioOnly:
		args = append(args, "-x", "--audio-format", "m4a")
	default:
		args = append(args, "--merge-output-format", "mp4", "-S", "res,ext:mp4:m4a")
	}
	if q.Subs && !audio {
		langs := q.SubLangs
		if strings.TrimSpace(langs) == "" {
			langs = "ar,en"
		}
		args = append(args, "--write-subs", "--write-auto-subs", "--sub-langs", langs, "--embed-subs")
	}
	if q.EmbedMeta {
		args = append(args, "--embed-metadata")
	}
	if q.EmbedThumb {
		args = append(args, "--embed-thumbnail", "--convert-thumbnails", "jpg")
	}
	if rateRe.MatchString(q.RateLimit) {
		args = append(args, "-r", q.RateLimit)
	}
	// اسم فاضي = yt-dlp يسمّي بعنوان الفيديو (من قايمة كليك يمين مثلاً)
	esc := strings.ReplaceAll(name, "%", "%%")
	switch {
	case q.Playlist && name == "":
		args = append(args, "-o", filepath.Join(outDir, "%(playlist_title).100B", "%(playlist_index)03d - %(title).120B.%(ext)s"))
	case q.Playlist:
		args = append(args, "-o", filepath.Join(outDir, esc, "%(playlist_index)03d - %(title).120B.%(ext)s"))
	case name == "":
		args = append(args, "-o", filepath.Join(outDir, "%(title).150B.%(ext)s"))
	default:
		args = append(args, "-o", filepath.Join(outDir, esc+".%(ext)s"))
	}
	return append(args, "--", q.URL)
}

// ───────────── الطابور والتشغيل ─────────────

func enqueue(q *Req) (string, bool, error) {
	if q.JobID == "" || !validURL(q.URL) || (q.AudioURL != "" && !validURL(q.AudioURL)) {
		return "", false, errors.New(tr("طلب غير صحيح", "invalid request"))
	}
	if q.Cmd == "merge" {
		if tool("ffmpeg") == "" {
			return "", false, errors.New(tr("ffmpeg مش موجود، شغّل "+installer+" تاني", "ffmpeg is missing, run "+installer+" again"))
		}
	} else if tool("yt-dlp") == "" {
		return "", false, errors.New(tr("yt-dlp مش موجود جنب المساعد، شغّل "+installer+" تاني", "yt-dlp is missing next to the helper, run "+installer+" again"))
	}
	outDir := filepath.Join(resolveBase(q.BaseDir), cleanRel(q.RelDir))
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", false, fmt.Errorf(tr("مش قادر أعمل الفولدر: %v", "can't create the folder: %v"), err)
	}
	name := cleanSegment(q.Name)
	if name == "" && q.Cmd == "merge" {
		name = "video"
	}

	j := &job{}
	jobsMu.Lock()
	jobs[q.JobID] = j
	jobsMu.Unlock()
	queued := lim.busy()

	wg.Add(1)
	go func() {
		defer wg.Done()
		defer func() { jobsMu.Lock(); delete(jobs, q.JobID); jobsMu.Unlock() }()
		if !lim.acquire(j.isCanceled, func() { event(q.JobID, "queued", nil) }) {
			event(q.JobID, "canceled", nil)
			return
		}
		defer lim.release()
		if q.Cmd == "merge" {
			runMerge(q, j, outDir, name)
		} else {
			runYtdlp(q, j, outDir, name)
		}
	}()
	return outDir, queued, nil
}

func startProc(j *job, cmd *exec.Cmd) (io.Reader, io.Reader, error) {
	cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8", "PYTHONUTF8=1")
	hideWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, nil, err
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.canceled {
		return nil, nil, errCanceled
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	j.cmd = cmd
	return stdout, stderr, nil
}

var errCanceled = errors.New("canceled")

// بيقرا stdout و stderr سطر بسطر لحد ما العملية تخلص
func pump(stdout, stderr io.Reader, onLine func(line, src string)) {
	var mu sync.Mutex
	scan := func(r io.Reader, src string, done chan struct{}) {
		defer close(done)
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r ")
			if line == "" {
				continue
			}
			mu.Lock()
			onLine(line, src)
			mu.Unlock()
		}
	}
	d1, d2 := make(chan struct{}), make(chan struct{})
	go scan(stdout, "stdout", d1)
	go scan(stderr, "stderr", d2)
	<-d1
	<-d2
}

func runYtdlp(q *Req, j *job, outDir, name string) {
	cookieFile, err := writeCookies(q.Cookies)
	if err != nil {
		event(q.JobID, "error", map[string]any{"message": err.Error()})
		return
	}
	if cookieFile != "" {
		defer os.Remove(cookieFile)
	}
	cmd := exec.Command(tool("yt-dlp"), ytdlpArgs(q, outDir, name, cookieFile)...)
	cmd.Dir = outDir
	stdout, stderr, err := startProc(j, cmd)
	if err == errCanceled {
		event(q.JobID, "canceled", nil)
		return
	}
	if err != nil {
		event(q.JobID, "error", map[string]any{"message": err.Error()})
		return
	}
	log.Printf("job %s yt-dlp pid=%d url=%s", q.JobID, cmd.Process.Pid, q.URL)
	event(q.JobID, "started", map[string]any{"dir": outDir})

	var (
		files    []string
		errLines []string
		last     time.Time
		lastPct  = -1.0
		part     = 1
		lastItem = ""
	)
	pump(stdout, stderr, func(line, src string) {
		switch {
		case strings.HasPrefix(line, "VS "):
			f := strings.Split(line[3:], "|")
			for len(f) < 8 {
				f = append(f, "")
			}
			pct := num(f[0])
			item := clean(f[6])
			if item != lastItem {
				lastItem, part, lastPct = item, 1, -1
			}
			if lastPct >= 95 && pct >= 0 && pct < 5 {
				part++ // بدأ يحمّل الجزء التاني (غالباً الصوت)
			}
			if pct >= 0 {
				lastPct = pct
			}
			if time.Since(last) < 400*time.Millisecond && pct < 100 {
				return
			}
			last = time.Now()
			total := num(f[4])
			if total <= 0 {
				total = num(f[5])
			}
			ev := map[string]any{
				"percent": pct, "speed": clean(f[1]), "eta": clean(f[2]),
				"downloaded": num(f[3]), "total": total, "part": part,
			}
			if n := num(f[7]); n > 0 && q.Playlist {
				ev["item"] = num(f[6])
				ev["items"] = n
			}
			event(q.JobID, "progress", ev)
		case strings.HasPrefix(line, "VSFILE "):
			files = append(files, strings.TrimSpace(line[7:]))
		case strings.HasPrefix(line, "VSTITLE "):
			event(q.JobID, "title", map[string]any{"title": strings.TrimSpace(line[8:])})
		default:
			log.Printf("job %s %s: %s", q.JobID, src, line)
			if src == "stderr" {
				errLines = append(errLines, strings.TrimSpace(line))
				if len(errLines) > 30 {
					errLines = errLines[1:]
				}
			}
		}
	})
	err = cmd.Wait()
	finish(q, j, err, errLines, func() map[string]any {
		out := map[string]any{"files": len(files)}
		switch {
		case q.Playlist && len(files) > 0:
			out["file"] = filepath.Dir(files[0])
		case len(files) > 0:
			out["file"] = files[len(files)-1]
		}
		return out
	}, func() {
		if name != "" {
			removePartials(outDir, name)
		}
	})
}

func finish(q *Req, j *job, err error, errLines []string, doneData func() map[string]any, cleanup func()) {
	switch {
	case j.isCanceled():
		cleanup()
		event(q.JobID, "canceled", nil)
	case err == nil:
		event(q.JobID, "done", doneData())
	default:
		msg := pickError(errLines)
		if msg == "" {
			msg = err.Error()
		}
		event(q.JobID, "error", map[string]any{"message": explain(msg, errLines)})
	}
	log.Printf("job %s finished err=%v canceled=%v", q.JobID, err, j.isCanceled())
}

// ───────────── الدمج بـffmpeg (صورة + صوت منفصلين، زي فيسبوك وانستجرام) ─────────────

var durRe = regexp.MustCompile(`Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)`)

func runMerge(q *Req, j *job, outDir, name string) {
	out := uniquePath(filepath.Join(outDir, name+".mp4"))
	hdr := ""
	if q.UserAgent != "" {
		hdr += "User-Agent: " + q.UserAgent + "\r\n"
	}
	if q.Referer != "" {
		hdr += "Referer: " + q.Referer + "\r\n"
	}
	args := []string{"-hide_banner", "-nostdin", "-y"}
	inputs := []string{q.URL}
	if q.AudioURL != "" {
		inputs = append(inputs, q.AudioURL)
	}
	for _, u := range inputs {
		if hdr != "" {
			args = append(args, "-headers", hdr)
		}
		args = append(args, "-i", u)
	}
	if q.AudioURL != "" {
		args = append(args, "-map", "0:v:0", "-map", "1:a:0")
	}
	args = append(args, "-c", "copy", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", out)

	cmd := exec.Command(tool("ffmpeg"), args...)
	cmd.Dir = outDir
	stdout, stderr, err := startProc(j, cmd)
	if err == errCanceled {
		event(q.JobID, "canceled", nil)
		return
	}
	if err != nil {
		event(q.JobID, "error", map[string]any{"message": err.Error()})
		return
	}
	log.Printf("job %s ffmpeg pid=%d", q.JobID, cmd.Process.Pid)
	event(q.JobID, "started", map[string]any{"dir": outDir})

	var (
		duration float64
		errLines []string
		last     time.Time
		size     float64
		speed    string
	)
	pump(stdout, stderr, func(line, src string) {
		if src == "stderr" {
			if duration == 0 {
				if m := durRe.FindStringSubmatch(line); m != nil {
					h, _ := strconv.ParseFloat(m[1], 64)
					mi, _ := strconv.ParseFloat(m[2], 64)
					s, _ := strconv.ParseFloat(m[3], 64)
					duration = h*3600 + mi*60 + s
				}
			}
			errLines = append(errLines, strings.TrimSpace(line))
			if len(errLines) > 30 {
				errLines = errLines[1:]
			}
			return
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return
		}
		switch k {
		case "total_size":
			size = num(v)
		case "speed":
			speed = strings.TrimSpace(v)
		case "out_time_us", "out_time_ms": // الاتنين بالميكروثانية في ffmpeg
			t := num(v) / 1e6
			pct := -1.0
			if duration > 0 && t >= 0 {
				pct = t / duration * 100
				if pct > 99.9 {
					pct = 99.9
				}
			}
			if time.Since(last) < 400*time.Millisecond {
				return
			}
			last = time.Now()
			event(q.JobID, "progress", map[string]any{"percent": pct, "speed": speed, "downloaded": size, "total": -1, "part": 1})
		}
	})
	err = cmd.Wait()
	if err != nil && !j.isCanceled() {
		os.Remove(out)
	}
	finish(q, j, err, ffmpegErrors(errLines), func() map[string]any {
		return map[string]any{"file": out, "files": 1}
	}, func() { os.Remove(out) })
}

func ffmpegErrors(lines []string) []string {
	var out []string
	for _, l := range lines {
		if strings.Contains(l, "Error") || strings.Contains(l, "error") || strings.Contains(l, "403") || strings.Contains(l, "404") || strings.Contains(l, "Invalid") {
			out = append(out, "ERROR: "+l)
		}
	}
	if len(out) == 0 {
		return lines
	}
	return out
}

// ───────────── مساعدات ─────────────

func num(s string) float64 {
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "%"))
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return -1
	}
	return f
}

func clean(s string) string {
	s = strings.TrimSpace(s)
	if s == "NA" || s == "N/A" || s == "None" || strings.HasPrefix(s, "Unknown") {
		return ""
	}
	return s
}

// رسالة أوضح للأخطاء المعروفة
func explain(msg string, lines []string) string {
	all := strings.Join(lines, "\n") + "\n" + msg
	noJS := strings.Contains(all, "JavaScript runtime") || strings.Contains(all, "Signature solving failed") || strings.Contains(all, "n challenge")
	switch {
	case noJS && tool("deno") == "":
		return msg + tr("\n← يوتيوب محتاج Deno: شغّل "+installer+" تاني عشان يتحمّل.", "\n→ YouTube needs Deno: run "+installer+" again.")
	case noJS:
		return msg + tr("\n← جرّب تحديث yt-dlp من الإعدادات.", "\n→ Try updating yt-dlp from the settings.")
	case strings.Contains(all, "Sign in to confirm"), strings.Contains(all, "login required"), strings.Contains(all, "rate-limit reached"):
		return msg + tr("\n← افتح الموقع في المتصفح وسجّل دخول، وبعدين جرّب تاني.", "\n→ Open the site in your browser, sign in, then try again.")
	case strings.Contains(all, "403"):
		return msg + tr("\n← اللينك ممكن يكون انتهى: اعمل ريفريش للصفحة، أو حدّث yt-dlp من الإعدادات.", "\n→ The link may have expired: refresh the page, or update yt-dlp from the settings.")
	case strings.Contains(all, "Unsupported URL"):
		return msg + tr("\n← yt-dlp مش بيدعم الموقع ده؛ شغّل الفيديو وحمّله من أيقونة هدهد.", "\n→ yt-dlp doesn't support this site; play the video and use the Hudhud icon.")
	}
	return msg
}

func pickError(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(lines[i], "ERROR:") {
			return strings.TrimSpace(strings.TrimPrefix(lines[i], "ERROR:"))
		}
	}
	if len(lines) > 0 {
		return lines[len(lines)-1]
	}
	return ""
}

func removePartials(dir, name string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, name) && (strings.Contains(n, ".part") || strings.HasSuffix(n, ".ytdl")) {
			os.Remove(filepath.Join(dir, n))
		}
	}
}

func cancelJob(id string) {
	jobsMu.Lock()
	j := jobs[id]
	jobsMu.Unlock()
	if j == nil {
		return
	}
	j.mu.Lock()
	j.canceled = true
	cmd := j.cmd
	j.mu.Unlock()
	lim.cond.Broadcast() // لو كان مستني في الطابور
	if cmd != nil && cmd.Process != nil {
		killTree(cmd)
	}
}

// ───────────── فحص الصفحة (yt-dlp -J) ─────────────

type ytInfo struct {
	Type          string            `json:"_type"`
	Title         string            `json:"title"`
	Duration      float64           `json:"duration"`
	Extractor     string            `json:"extractor_key"`
	IsLive        bool              `json:"is_live"`
	Thumbnail     string            `json:"thumbnail"`
	Uploader      string            `json:"uploader"`
	Channel       string            `json:"channel"`
	PlaylistCount int               `json:"playlist_count"`
	Entries       []json.RawMessage `json:"entries"`
	Formats       []ytFormat        `json:"formats"`
}

type ytFormat struct {
	Height         *int    `json:"height"`
	Vcodec         string  `json:"vcodec"`
	Acodec         string  `json:"acodec"`
	Ext            string  `json:"ext"`
	Filesize       float64 `json:"filesize"`
	FilesizeApprox float64 `json:"filesize_approx"`
	Tbr            float64 `json:"tbr"`
}

// size of one format in bytes: exact, yt-dlp's estimate, or bitrate × duration. approx tells which.
func (f ytFormat) size(duration float64) (bytes float64, approx bool) {
	switch {
	case f.Filesize > 0:
		return f.Filesize, false
	case f.FilesizeApprox > 0:
		return f.FilesizeApprox, true
	case f.Tbr > 0 && duration > 0:
		return f.Tbr * 1000 / 8 * duration, true
	}
	return 0, true
}

func hasV(f ytFormat) bool { return f.Vcodec != "" && f.Vcodec != "none" }
func hasA(f ytFormat) bool { return f.Acodec != "" && f.Acodec != "none" }

// better reports whether a is preferred over b the way "-S res,ext:mp4:m4a" picks: wanted ext first, then bitrate.
func better(a, b ytFormat, ext string) bool {
	if (a.Ext == ext) != (b.Ext == ext) {
		return a.Ext == ext
	}
	return a.Tbr > b.Tbr
}

// estimateSizes: the expected file size for each height (best video of that height + best audio, as
// formatFor/-S choose them) and for audio only. 0 = unknown. Sizes are rounded estimates for the menu.
func estimateSizes(formats []ytFormat, duration float64) (map[int]map[string]any, map[string]any) {
	var bestA *ytFormat
	for i, f := range formats {
		if hasA(f) && !hasV(f) && (bestA == nil || better(f, *bestA, "m4a")) {
			bestA = &formats[i]
		}
	}
	aSize, aApprox := 0.0, true
	if bestA != nil {
		aSize, aApprox = bestA.size(duration)
	}
	bestV := map[int]ytFormat{}
	for _, f := range formats {
		if f.Height == nil || *f.Height <= 0 || !hasV(f) {
			continue
		}
		if cur, ok := bestV[*f.Height]; !ok || better(f, cur, "mp4") {
			bestV[*f.Height] = f
		}
	}
	out := map[int]map[string]any{}
	for h, f := range bestV {
		v, approx := f.size(duration)
		if v > 0 && !hasA(f) {
			if aSize > 0 {
				v += aSize
				approx = approx || aApprox
			} else {
				approx = true
			}
		}
		out[h] = map[string]any{"bytes": int64(v), "approx": approx}
	}
	audio := map[string]any{"m4a": int64(aSize), "approx": aApprox}
	// MP3 at --audio-quality 0 is VBR around 245 kb/s
	if duration > 0 {
		audio["mp3"] = int64(245000 / 8 * duration)
	} else {
		audio["mp3"] = int64(0)
	}
	return out, audio
}

func runJSON(q *Req, playlist bool) (*ytInfo, error) {
	cookieFile, err := writeCookies(q.Cookies)
	if err != nil {
		return nil, err
	}
	if cookieFile != "" {
		defer os.Remove(cookieFile)
	}
	qq := *q
	qq.Playlist = playlist
	args := append(commonArgs(&qq, cookieFile), "-J", "--flat-playlist", "--no-warnings", "--", q.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool("yt-dlp"), args...)
	cmd.Env = append(os.Environ(), "PYTHONIOENCODING=utf-8", "PYTHONUTF8=1")
	hideWindow(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		lines := strings.Split(strings.TrimSpace(stderr.String()), "\n")
		msg := pickError(lines)
		if msg == "" {
			msg = err.Error()
		}
		return nil, errors.New(explain(msg, lines))
	}
	var in ytInfo
	if err := json.Unmarshal(stdout.Bytes(), &in); err != nil {
		return nil, fmt.Errorf(tr("رد غير مفهوم من yt-dlp: %v", "unreadable yt-dlp output: %v"), err)
	}
	return &in, nil
}

func probe(q *Req) (map[string]any, error) {
	if !validURL(q.URL) {
		return nil, errors.New(tr("لينك غير صحيح", "invalid link"))
	}
	if tool("yt-dlp") == "" {
		return nil, errors.New(tr("yt-dlp مش موجود", "yt-dlp is missing"))
	}
	in, err := runJSON(q, false)
	if err != nil {
		return nil, err
	}
	res := map[string]any{
		"title": in.Title, "duration": int(in.Duration), "extractor": in.Extractor,
		"live": in.IsLive, "thumbnail": in.Thumbnail, "uploader": in.Uploader, "channel": in.Channel, "heights": []int{}, "hasAudio": false,
		"isPlaylist": false, "playlistCount": 0, "playlistTitle": "",
	}
	if in.Type == "playlist" {
		res["isPlaylist"] = true
		res["playlistTitle"] = in.Title
		res["playlistCount"] = max(in.PlaylistCount, len(in.Entries))
		return res, nil
	}
	seen := map[int]bool{}
	var heights []int
	hasAudio := false
	for _, f := range in.Formats {
		if f.Acodec != "" && f.Acodec != "none" {
			hasAudio = true
		}
		if f.Height != nil && *f.Height > 0 && f.Vcodec != "none" && !seen[*f.Height] {
			seen[*f.Height] = true
			heights = append(heights, *f.Height)
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(heights)))
	if heights == nil {
		heights = []int{}
	}
	res["heights"] = heights
	res["hasAudio"] = hasAudio || len(in.Formats) == 0
	sizes, audio := estimateSizes(in.Formats, in.Duration)
	bySize := map[string]any{}
	for h, s := range sizes {
		bySize[strconv.Itoa(h)] = s
	}
	res["sizes"] = bySize
	res["audioSizes"] = audio
	// فيديو جوه playlist (زي youtube.com/watch?v=..&list=..): نعرض الاختيارين
	if strings.Contains(q.URL, "list=") {
		if pl, err := runJSON(q, true); err == nil && pl.Type == "playlist" {
			res["playlistTitle"] = pl.Title
			res["playlistCount"] = max(pl.PlaylistCount, len(pl.Entries))
		}
	}
	return res, nil
}
