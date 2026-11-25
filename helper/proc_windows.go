//go:build windows

package main

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const createNoWindow = 0x08000000

func hideWindow(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// yt-dlp بيشغّل ffmpeg كعملية فرعية، فلازم نقفل الشجرة كلها
func killTree(c *exec.Cmd) {
	k := exec.Command("taskkill", "/PID", strconv.Itoa(c.Process.Pid), "/T", "/F")
	hideWindow(k)
	if err := k.Run(); err != nil {
		c.Process.Kill()
	}
}

const installer = "install.bat"

func platformDownloads() string { return "" }

// explorer حساس جداً في الـquoting، فبنبني سطر الأوامر بإيدينا
func explorer(arg string) error {
	c := exec.Command("explorer.exe")
	c.SysProcAttr = &syscall.SysProcAttr{CmdLine: "explorer.exe " + arg}
	return c.Start()
}

func revealPath(p string, isDir bool) error {
	if isDir {
		return explorer(`"` + p + `"`)
	}
	return explorer(`/select,"` + p + `"`)
}

func openFolder(dir string) error { return explorer(`"` + dir + `"`) }

const folderDialogPS = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true; ShowInTaskbar = $false}
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Hudhud - choose download folder'
$d.ShowNewFolderButton = $true
if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }`

func chooseFolder() (string, error) {
	out, err := runCaptureVisible(10*time.Minute, "powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", folderDialogPS)
	if err != nil {
		return "", errors.New(tr("مش قادر أفتح نافذة اختيار الفولدر", "can't open the folder picker"))
	}
	return strings.TrimSpace(out), nil
}

// نافذة الاختيار بتظهر عادي حتى مع CREATE_NO_WINDOW (ده بيخفي الكونسول بس)
func runCaptureVisible(timeout time.Duration, name string, args ...string) (string, error) {
	c := exec.Command(name, args...)
	c.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	done := make(chan struct{})
	var out []byte
	var err error
	go func() { out, err = c.Output(); close(done) }()
	select {
	case <-done:
		return string(out), err
	case <-time.After(timeout):
		if c.Process != nil {
			c.Process.Kill()
		}
		return "", errors.New("timeout")
	}
}
