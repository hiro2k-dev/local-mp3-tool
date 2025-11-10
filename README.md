# MP3 File Tool

A lightweight Node.js script to automatically **rename MP3 files** using their real metadata (ID3 tags) and optionally **delete broken/unplayable files**. I use this tool for manage file for my mp3 player.

---

## Setup

```bash
yarn
node run.js --dir "<<url>>" --pattern "{title} - {artist}" --recursive --delete-bad
```
