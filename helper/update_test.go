package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeZip(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(body))
	}
	zw.Close()
	return buf.Bytes()
}

func setupInstall(t *testing.T) (dir string) {
	t.Helper()
	dir = t.TempDir()
	exeDir = dir
	exe := filepath.Join(dir, filepath.Base(helperEntry()))
	os.WriteFile(exe, []byte("old-helper"), 0o755)
	exePath = func() string { return exe }
	os.MkdirAll(filepath.Join(dir, "extension", "lib"), 0o755)
	os.WriteFile(filepath.Join(dir, "extension", "manifest.json"), []byte(`{"version":"0.8.1"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "extension", "lib", "gone.js"), []byte("old"), 0o644)
	os.WriteFile(filepath.Join(dir, "install-id"), []byte("abc123\n"), 0o644)
	return dir
}

func serveRelease(t *testing.T, zipBytes []byte, badSum bool) {
	serveReleaseAs(t, "hudhud-v9.9.9-"+osLabel()+".zip", zipBytes, badSum)
}

func serveReleaseAs(t *testing.T, name string, zipBytes []byte, badSum bool) {
	t.Helper()
	sum := sha256.Sum256(zipBytes)
	hexsum := hex.EncodeToString(sum[:])
	if badSum {
		hexsum = strings.Repeat("0", 64)
	}
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/latest", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"tag_name": "v9.9.9",
			"assets": []map[string]string{
				{"name": name, "browser_download_url": srv.URL + "/pkg"},
				{"name": "hudhud-v9.9.9-extension-only.zip", "browser_download_url": srv.URL + "/nope"},
				{"name": "SHA256SUMS.txt", "browser_download_url": srv.URL + "/sums"},
			},
		})
	})
	mux.HandleFunc("/pkg", func(w http.ResponseWriter, r *http.Request) { w.Write(zipBytes) })
	mux.HandleFunc("/sums", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "%s  %s\n%s  other.zip\n", hexsum, name, strings.Repeat("1", 64))
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	releaseAPI = srv.URL + "/latest"
}

func TestSelfUpdate(t *testing.T) {
	dir := setupInstall(t)
	serveRelease(t, makeZip(t, map[string]string{
		helperEntry():                  "new-helper",
		"extension/manifest.json":      `{"version":"9.9.9"}`,
		"extension/popup.html":         "<html>",
		"extension/../evil.txt":        "nope",
		"install.sh":                   "#!/bin/sh",
		"bin/hudhud-helper-plan9-mips": "other arch",
	}), false)

	if info()["installId"] != "abc123" || info()["extVersion"] != "0.8.1" {
		t.Fatalf("info before: %v", info())
	}
	res, err := selfUpdate(false)
	if err != nil {
		t.Fatal(err)
	}
	if res["version"] != "9.9.9" {
		t.Fatalf("version %v", res)
	}
	b, _ := os.ReadFile(exePath())
	if string(b) != "new-helper" {
		t.Fatalf("helper not replaced: %q", b)
	}
	if managedExtensionVersion() != "9.9.9" {
		t.Fatal("extension not replaced")
	}
	if _, err := os.Stat(filepath.Join(dir, "extension", "lib", "gone.js")); err == nil {
		t.Fatal("old extension files left behind")
	}
	stamp, _ := os.ReadFile(filepath.Join(dir, "extension", "hudhud-install.json"))
	if !strings.Contains(string(stamp), `"abc123"`) {
		t.Fatalf("install stamp %q", stamp)
	}
	for _, p := range []string{"evil.txt", ".update", "extension.old"} {
		if _, err := os.Stat(filepath.Join(dir, p)); err == nil {
			t.Fatalf("%s should not exist", p)
		}
	}
	cleanupOldUpdate()
}

func TestSelfUpdateBadChecksum(t *testing.T) {
	dir := setupInstall(t)
	serveRelease(t, makeZip(t, map[string]string{helperEntry(): "new", "extension/manifest.json": `{"version":"9.9.9"}`}), true)
	if _, err := selfUpdate(false); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("want checksum error, got %v", err)
	}
	b, _ := os.ReadFile(exePath())
	if string(b) != "old-helper" || managedExtensionVersion() != "0.8.1" {
		t.Fatal("install changed after a failed update")
	}
	_ = dir
}

func TestSelfUpdateNeedsManagedInstall(t *testing.T) {
	dir := setupInstall(t)
	os.Remove(filepath.Join(dir, "install-id"))
	if _, err := selfUpdate(false); err == nil {
		t.Fatal("want error without install-id")
	}
}

func TestSelfUpdateIncompletePackage(t *testing.T) {
	setupInstall(t)
	serveRelease(t, makeZip(t, map[string]string{"extension/manifest.json": `{"version":"9.9.9"}`}), false)
	if _, err := selfUpdate(false); err == nil {
		t.Fatal("want error for a package without the helper")
	}
	if managedExtensionVersion() != "0.8.1" {
		t.Fatal("install changed after a failed update")
	}
}

func TestSelfUpdateLegacyAssetName(t *testing.T) {
	setupInstall(t)
	serveReleaseAs(t, legacyAssetName(), makeZip(t, map[string]string{helperEntry(): "new-helper", "extension/manifest.json": `{"version":"9.9.9"}`}), false)
	if _, err := selfUpdate(false); err != nil {
		t.Fatal(err)
	}
	if managedExtensionVersion() != "9.9.9" {
		t.Fatal("not updated from a legacy-named package")
	}
}

func TestSelfUpdateHelperOnly(t *testing.T) {
	dir := setupInstall(t)
	os.Remove(filepath.Join(dir, "install-id")) // Firefox installs don't need the managed extension
	serveRelease(t, makeZip(t, map[string]string{helperEntry(): "new-helper"}), false)
	if _, err := selfUpdate(true); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(exePath())
	if string(b) != "new-helper" || managedExtensionVersion() != "0.8.1" {
		t.Fatalf("helper %q ext %s", b, managedExtensionVersion())
	}
}
