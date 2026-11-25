package main

import (
	"strings"
	"sync/atomic"
)

// UI language for messages shown to the user ("ar" or "en"); sent by the extension in "config".
var uiLang atomic.Value

func setLang(l string) {
	if strings.HasPrefix(strings.ToLower(l), "ar") {
		uiLang.Store("ar")
	} else {
		uiLang.Store("en")
	}
}

func tr(ar, en string) string {
	if v, _ := uiLang.Load().(string); v == "en" {
		return en
	}
	return ar
}
