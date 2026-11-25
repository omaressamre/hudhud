# Privacy

**Short version: Hudhud collects nothing.**

- **No analytics, no telemetry, no accounts.** The extension and the helper never send data about you or your usage to the developer or anyone else.
- **Network requests Hudhud makes:**
  - the media you choose to download, fetched from the site that serves it, with your browser's normal cookies for that site;
  - with the helper: yt-dlp contacts the video site you asked for; the installer and the "Update yt-dlp" button download yt-dlp, ffmpeg and Deno from their official GitHub/project releases;
  - when the browser starts (at most every 12 hours) and right after install, the extension asks `api.github.com` for the latest Hudhud release version to tell you if the helper is out of date. Nothing about you is sent beyond a standard HTTP request.
- **Stored locally only:** your settings, your recent download list and a download counter (used to show the support message occasionally). All of it stays in your browser's extension storage and can be cleared by removing the extension.
- **Permissions:** Hudhud reads network requests to spot video URLs and reads pages only to find media on them. It does not read or store anything else from the pages you visit.
- **DRM:** Hudhud does not decrypt or bypass protected content.

Questions: open an issue at https://github.com/omaressamre/hudhud/issues.

---

# الخصوصية

**باختصار: هدهد مش بيجمع أي بيانات.**

- مفيش تحليلات ولا تتبّع ولا حسابات. لا الإضافة ولا المساعد بيبعتوا أي بيانات عنك أو عن استخدامك لأي حد.
- الطلبات اللي بيعملها هدهد: الفيديو اللي انت بتختار تنزّله من الموقع نفسه؛ ومع المساعد، yt-dlp بيكلّم الموقع اللي طلبته، والمثبّت بينزّل yt-dlp وffmpeg وDeno من مصادرهم الرسمية؛ ولما المتصفح يفتح (مرة كل 12 ساعة على الأكثر) وبعد التثبيت على طول، الإضافة بتسأل GitHub عن رقم آخر إصدار.
- اللي بيتخزّن على جهازك بس: إعداداتك، قائمة التنزيلات الأخيرة، وعدّاد التنزيلات. كله بيتمسح لما تشيل الإضافة.
- هدهد مش بيفك أو يتخطّى حماية المحتوى (DRM).
