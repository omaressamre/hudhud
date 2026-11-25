package main

// One-click update of Hudhud itself (helper + extension).
//
// The installer copies the extension into <install>/extension and writes the same random id to
// <install>/install-id and <install>/extension/hudhud-install.json. The extension reads its copy and
// compares it with info().installId: when they match, Chrome is running the extension from our
// folder, so we can replace its files and the extension just calls chrome.runtime.reload().
//
// selfUpdate downloads the release zip for this OS from GitHub, checks it against SHA256SUMS.txt
// from the same release, and swaps in the new extension folder and helper binary. The running
// helper keeps working; the new binary is used from the next connection.

import (
	"archive/zip"
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const repo = "omaressamre/hudhud"

var (
	// overridable in tests
	releaseAPI = "https://api.github.com/repos/" + repo + "/releases/latest"
	httpClient = &http.Client{Timeout: 10 * time.Minute}
	exePath    = func() string { p, _ := os.Executable(); return p }
)

func init() {
	if v := os.Getenv("HUDHUD_RELEASE_API"); v != "" { // tests only
		releaseAPI = v
	}
}

func installDir() string { return exeDir }

func installID() string {
	b, err := os.ReadFile(filepath.Join(installDir(), "install-id"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// managedExtensionVersion is the version of the extension copy in our folder ("" when there is none).
func managedExtensionVersion() string {
	var m struct {
		Version string `json:"version"`
	}
	b, err := os.ReadFile(filepath.Join(installDir(), "extension", "manifest.json"))
	if err != nil || json.Unmarshal(b, &m) != nil {
		return ""
	}
	return m.Version
}

// managedExtensionDir is the folder Chrome should load the extension from ("" when there is none).
func managedExtensionDir() string {
	if managedExtensionVersion() == "" {
		return ""
	}
	return filepath.Join(installDir(), "extension")
}

func osLabel() string {
	switch runtime.GOOS {
	case "windows":
		return "windows"
	case "darwin":
		return "macos"
	default:
		return "linux"
	}
}

// legacyAssetName is the package name used up to 0.9.3 (still published for older helpers).
func legacyAssetName() string { return "hudhud-helper-" + osLabel() + ".zip" }

// packageAsset picks this platform's package from a release: hudhud-vX.Y.Z-<os>.zip, or the legacy name.
func (r *release) packageAsset() (name, url string) {
	re := regexp.MustCompile(`^hudhud-v[0-9][0-9.]*-` + osLabel() + `\.zip$`)
	for _, a := range r.Assets {
		if re.MatchString(a.Name) {
			return a.Name, a.URL
		}
	}
	return legacyAssetName(), r.asset(legacyAssetName())
}

// helperEntry is the path of this platform's helper binary inside the release zip.
func helperEntry() string {
	if runtime.GOOS == "windows" {
		return "hudhud-helper.exe"
	}
	return "bin/hudhud-helper-" + runtime.GOOS + "-" + runtime.GOARCH
}

type release struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
	} `json:"assets"`
}

func latestRelease() (*release, error) {
	req, _ := http.NewRequest("GET", releaseAPI, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "hudhud-helper/"+Version)
	res, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub: %s", res.Status)
	}
	var r release
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (r *release) asset(name string) string {
	for _, a := range r.Assets {
		if a.Name == name {
			return a.URL
		}
	}
	return ""
}

func fetchTo(url, path string) (string, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "hudhud-helper/"+Version)
	res, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("%s: %s", filepath.Base(path), res.Status)
	}
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), io.LimitReader(res.Body, 500<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return hex.EncodeToString(h.Sum(nil)), err
}

func expectedSum(sumsFile, name string) string {
	f, err := os.Open(sumsFile)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fs := strings.Fields(sc.Text())
		if len(fs) == 2 && strings.TrimPrefix(fs[1], "*") == name {
			return strings.ToLower(fs[0])
		}
	}
	return ""
}

// unzipUpdate extracts extension/** into extDir and the helper binary into binPath.
func unzipUpdate(zipPath, extDir, binPath string, needExt bool) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	gotBin, gotManifest := false, false
	for _, f := range zr.File {
		name := strings.TrimPrefix(filepath.ToSlash(f.Name), "./")
		var out string
		switch {
		case name == helperEntry():
			out, gotBin = binPath, true
		case strings.HasPrefix(name, "extension/") && !f.FileInfo().IsDir():
			rel := strings.TrimPrefix(name, "extension/")
			if rel == "" || strings.Contains(rel, "..") {
				continue
			}
			out = filepath.Join(extDir, filepath.FromSlash(rel))
			if rel == "manifest.json" {
				gotManifest = true
			}
		default:
			continue
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.OpenFile(out, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(w, rc)
		rc.Close()
		if cerr := w.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
	}
	if !gotBin || (needExt && !gotManifest) {
		return errors.New(tr("ملف التحديث ناقص", "the update package is incomplete"))
	}
	return nil
}

// copyTree copies every file of src over dst (used when the folder can't be renamed on Windows).
func copyTree(src, dst string) error {
	return filepath.Walk(src, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		t := filepath.Join(dst, rel)
		if fi.IsDir() {
			return os.MkdirAll(t, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(t, b, 0o644)
	})
}

// cleanupOldUpdate removes leftovers of a previous update (called at start).
func cleanupOldUpdate() {
	dir := installDir()
	os.RemoveAll(filepath.Join(dir, "extension.old"))
	os.RemoveAll(filepath.Join(dir, ".update"))
	exe := filepath.Base(exePath())
	os.Remove(filepath.Join(dir, exe+".old"))
}

var selfUpdateMu = make(chan struct{}, 1)

// selfUpdate replaces the helper and, unless helperOnly, the managed extension folder.
func selfUpdate(helperOnly bool) (map[string]any, error) {
	select {
	case selfUpdateMu <- struct{}{}:
		defer func() { <-selfUpdateMu }()
	default:
		return nil, errors.New(tr("التحديث شغال بالفعل", "an update is already running"))
	}
	id := installID()
	if !helperOnly && (id == "" || managedExtensionVersion() == "") {
		return nil, errors.New(tr("التحديث التلقائي محتاج الإضافة تكون متسطّبة من فولدر هدهد", "automatic update needs the extension installed from the Hudhud folder"))
	}
	rel, err := latestRelease()
	if err != nil {
		return nil, fmt.Errorf("%s: %v", tr("مقدرتش أوصل لـGitHub", "couldn't reach GitHub"), err)
	}
	latest := strings.TrimPrefix(rel.Tag, "v")
	pkgName, zipURL := rel.packageAsset()
	sumsURL := rel.asset("SHA256SUMS.txt")
	if zipURL == "" || sumsURL == "" {
		return nil, errors.New(tr("الإصدار ده مفيهوش ملف لنظامك", "this release has no package for your system"))
	}

	dir := installDir()
	work := filepath.Join(dir, ".update")
	os.RemoveAll(work)
	if err := os.MkdirAll(work, 0o755); err != nil {
		return nil, err
	}
	defer os.RemoveAll(work)

	if _, err := fetchTo(sumsURL, filepath.Join(work, "SHA256SUMS.txt")); err != nil {
		return nil, err
	}
	zipPath := filepath.Join(work, pkgName)
	got, err := fetchTo(zipURL, zipPath)
	if err != nil {
		return nil, err
	}
	if want := expectedSum(filepath.Join(work, "SHA256SUMS.txt"), pkgName); want == "" || want != got {
		return nil, errors.New(tr("ملف التحديث مش سليم (checksum)", "the update file failed its checksum"))
	}

	newExt := filepath.Join(work, "extension")
	newBin := filepath.Join(work, "helper.new")
	if err := unzipUpdate(zipPath, newExt, newBin, !helperOnly); err != nil {
		return nil, err
	}
	if !helperOnly {
		if err := swapExtension(dir, newExt, id); err != nil {
			return nil, err
		}
	}
	return swapHelper(newBin, latest)
}

// swapExtension replaces <dir>/extension with newExt (stamped with the install id).
func swapExtension(dir, newExt, id string) error {
	stamp, _ := json.Marshal(map[string]string{"id": id})
	if err := os.WriteFile(filepath.Join(newExt, "hudhud-install.json"), stamp, 0o644); err != nil {
		return err
	}
	// rename swap, or copy over in place if Windows holds a handle on the folder: rename swap, or copy over in place if Windows holds a handle on it
	ext := filepath.Join(dir, "extension")
	old := filepath.Join(dir, "extension.old")
	os.RemoveAll(old)
	if err := os.Rename(ext, old); err == nil {
		if err := os.Rename(newExt, ext); err != nil {
			os.Rename(old, ext)
			return err
		}
		os.RemoveAll(old)
	} else if err := copyTree(newExt, ext); err != nil {
		return err
	}
	return nil
}

// swapHelper puts newBin in place of the running helper (a running exe can be renamed, also on Windows).
func swapHelper(newBin, latest string) (map[string]any, error) {
	exe := exePath()
	os.Remove(exe + ".old")
	if err := os.Rename(exe, exe+".old"); err != nil {
		return nil, err
	}
	if err := os.Rename(newBin, exe); err != nil {
		os.Rename(exe+".old", exe)
		return nil, err
	}
	os.Chmod(exe, 0o755)
	if runtime.GOOS != "windows" {
		os.Remove(exe + ".old")
	}
	log.Printf("self-update %s -> %s", Version, latest)
	return map[string]any{"version": latest}, nil
}
