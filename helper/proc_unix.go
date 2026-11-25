//go:build !windows

// حاجات خاصة بماك ولينكس: قفل العمليات، إظهار الملف، فتح الفولدر، ونافذة اختيار الفولدر.
package main

import (
	"context"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const installer = "install.sh"

// كل عملية بتبدأ في process group لوحدها، عشان الإلغاء يقفل كمان ffmpeg اللي yt-dlp مشغّله
func hideWindow(c *exec.Cmd) {
	if c.SysProcAttr == nil {
		c.SysProcAttr = &syscall.SysProcAttr{}
	}
	c.SysProcAttr.Setpgid = true
}

func killTree(c *exec.Cmd) {
	if c.Process == nil {
		return
	}
	pid := c.Process.Pid
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil {
		c.Process.Kill()
		return
	}
	go func() {
		time.Sleep(1500 * time.Millisecond)
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}()
}

func quick(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return strings.TrimSpace(string(out)), err
}

// فولدر التنزيلات: على لينكس ممكن يبقى باسم تاني (مثلاً "التنزيلات") حسب لغة النظام
func platformDownloads() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	if _, err := exec.LookPath("xdg-user-dir"); err != nil {
		return ""
	}
	d, err := quick(3*time.Second, "xdg-user-dir", "DOWNLOAD")
	home, _ := os.UserHomeDir()
	if err != nil || d == "" || d == home {
		return ""
	}
	return d
}

func startDetached(name string, args ...string) error {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := c.Start(); err != nil {
		return err
	}
	go c.Wait()
	return nil
}

func openFolder(dir string) error {
	if runtime.GOOS == "darwin" {
		return startDetached("open", dir)
	}
	if _, err := exec.LookPath("xdg-open"); err != nil {
		return errors.New(tr("مش لاقي xdg-open لفتح الفولدر", "xdg-open not found to open the folder"))
	}
	return startDetached("xdg-open", dir)
}

func revealPath(p string, isDir bool) error {
	if isDir {
		return openFolder(p)
	}
	if runtime.GOOS == "darwin" {
		return startDetached("open", "-R", p) // Finder بيفتح الفولدر والملف متحدد
	}
	// لينكس: مدير الملفات (Nautilus/Dolphin/Nemo...) يحدد الملف، ولو ما نفعش نفتح الفولدر بس
	if _, err := exec.LookPath("dbus-send"); err == nil {
		uri := (&url.URL{Scheme: "file", Path: p}).String()
		if _, err := quick(3*time.Second, "dbus-send", "--session", "--print-reply", "--dest=org.freedesktop.FileManager1",
			"--type=method_call", "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems",
			"array:string:"+uri, "string:"); err == nil {
			return nil
		}
	}
	dir := p
	if i := strings.LastIndex(p, "/"); i > 0 {
		dir = p[:i]
	}
	return openFolder(dir)
}

func chooseFolder() (string, error) {
	if runtime.GOOS == "darwin" {
		out, err := quick(10*time.Minute, "osascript",
			"-e", "activate",
			"-e", "try",
			"-e", `return POSIX path of (choose folder with prompt "Hudhud - choose download folder")`,
			"-e", "on error number -128",
			"-e", `return ""`,
			"-e", "end try")
		if err != nil {
			return "", errors.New(tr("مش قادر أفتح نافذة اختيار الفولدر", "can't open the folder picker"))
		}
		if len(out) > 1 {
			out = strings.TrimRight(out, "/")
		}
		return out, nil
	}
	// لينكس: أي أداة موجودة من دول
	tools := [][]string{
		{"zenity", "--file-selection", "--directory", "--title=Hudhud - choose download folder"},
		{"kdialog", "--getexistingdirectory", os.Getenv("HOME"), "--title", "Hudhud - choose download folder"},
		{"yad", "--file", "--directory", "--title=Hudhud - choose download folder"},
		{"qarma", "--file-selection", "--directory", "--title=Hudhud - choose download folder"},
	}
	for _, t := range tools {
		if _, err := exec.LookPath(t[0]); err != nil {
			continue
		}
		out, err := quick(10*time.Minute, t[0], t[1:]...)
		if err != nil {
			var ee *exec.ExitError
			if errors.As(err, &ee) && ee.ExitCode() == 1 {
				return "", nil // المستخدم داس Cancel
			}
			return "", err
		}
		return strings.TrimSpace(strings.Split(out, "|")[0]), nil
	}
	return "", errors.New(tr("مفيش أداة لاختيار الفولدر على الجهاز؛ اكتب المسار بإيدك في الخانة، أو ثبّت zenity", "no folder picker available; type the path in the box instead"))
}
