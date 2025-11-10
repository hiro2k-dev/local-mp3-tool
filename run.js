import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream, statSync } from "node:fs";
import * as mm from "music-metadata";
import sanitize from "sanitize-filename";
import { spawn } from "node:child_process";
import { globby } from "globby";

// Try load ffprobe
let ffprobeBin = null;
try {
    const ffprobe = await import("ffprobe-static");
    ffprobeBin = ffprobe.default?.path || ffprobe.path || null;
} catch {}

/* ---------- Helpers ---------- */
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        dir: "",
        recursive: false,
        pattern: "{artist} - {title}",
        dryRun: false,
        deleteBad: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--dir") opts.dir = args[++i] ?? "";
        else if (a === "--recursive") opts.recursive = true;
        else if (a === "--pattern") opts.pattern = args[++i] ?? opts.pattern;
        else if (a === "--dry-run") opts.dryRun = true;
        else if (a === "--delete-bad") opts.deleteBad = true;
    }
    if (!opts.dir) {
        console.error("Missing --dir \"path/to/folder\"");
        process.exit(1);
    }
    return opts;
}

function toPosix(p) {
    return p.replace(/\\/g, "/");
}

function buildNameFromPattern(tags, pattern) {
    const safe = (v) => (v ?? "").toString().trim();
    const title = safe(tags.common?.title) || "";
    const artist = safe(
        Array.isArray(tags.common?.artist)
            ? tags.common.artist.join(", ")
            : tags.common?.artist ||
                    (Array.isArray(tags.common?.artists)
                        ? tags.common.artists.join(", ")
                        : tags.common?.artists)
    );
    const album = safe(tags.common?.album);
    const trackNo = tags.common?.track?.no
        ? String(tags.common.track.no).padStart(2, "0")
        : "";
    const map = {
        "{title}": title,
        "{artist}": artist,
        "{album}": album,
        "{track}": trackNo,
    };
    let out = pattern;
    for (const [k, v] of Object.entries(map)) out = out.replaceAll(k, v);
    out = out
        .replace(/\s+/g, " ")
        .replace(/\s*-\s*/g, " - ")
        .trim();
    out = sanitize(out);
    if (!out) out = "unknown";
    return out;
}

async function ensureUniqueName(dir, baseName, ext) {
    let candidate = `${baseName}${ext}`;
    let idx = 1;
    while (true) {
        try {
            await fs.access(path.join(dir, candidate));
            candidate = `${baseName} (${idx++})${ext}`;
        } catch {
            return candidate;
        }
    }
}

async function checkPlayableWithMetadata(file) {
    try {
        const stream = createReadStream(file, { start: 0, end: 64 * 1024 });
        const metadata = await mm.parseStream(
            stream,
            { mimeType: "audio/mpeg" },
            { duration: true }
        );
        stream.destroy();
        const duration = metadata?.format?.duration ?? 0;
        if (!duration) {
            const metaFull = await mm.parseFile(file, { duration: true });
            if ((metaFull?.format?.duration ?? 0) > 0) return true;
        }
        return duration > 0;
    } catch {
        return false;
    }
}

function checkPlayableWithFfprobe(file) {
    return new Promise((resolve) => {
        if (!ffprobeBin) return resolve(null);
        const args = [
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            file,
        ];
        const ps = spawn(ffprobeBin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        ps.stdout.on("data", (d) => (out += d.toString()));
        ps.on("close", (code) => {
            if (code !== 0) return resolve(false);
            const dur = parseFloat((out || "").trim());
            if (!isFinite(dur) || dur <= 0) return resolve(false);
            resolve(true);
        });
    });
}

async function processFile(file, opts) {
    let tags = null;
    try {
        tags = await mm.parseFile(file, { duration: true });
    } catch {}
    const ext = path.extname(file).toLowerCase();
    const dir = path.dirname(file);
    const oldBase = path.basename(file, ext);
    const newBase = buildNameFromPattern(tags || {}, opts.pattern) || oldBase;
    const finalName = await ensureUniqueName(dir, newBase, ext);
    const playableMeta = await checkPlayableWithMetadata(file);
    let playable = playableMeta;
    if (ffprobeBin) {
        const probe = await checkPlayableWithFfprobe(file);
        if (probe !== null) playable = probe;
    }
    return {
        file,
        oldName: path.basename(file),
        newName: finalName,
        willRename: finalName !== path.basename(file),
        playable,
    };
}

/* ---------- Main ---------- */
async function main() {
    const opts = parseArgs();
    const base = toPosix(opts.dir);
    const patterns = opts.recursive
        ? [`${base}/**/*.{mp3,MP3}`]
        : [`${base}/*.{mp3,MP3}`];

    const files = await globby(patterns, {
        dot: false,
        onlyFiles: true,
        followSymbolicLinks: false,
        caseSensitiveMatch: false,
        absolute: true,
    });

    if (!files.length) {
        console.log("No .mp3 files found.");
        return;
    }

    console.log(`Found ${files.length} MP3 file(s) under: ${opts.dir}\n`);
    files
        .slice(0, 30)
        .forEach((f, i) => console.log(`${String(i + 1).padStart(2)}. ${f}`));
    if (files.length > 30)
        console.log(`... (${files.length - 30} more not shown)\n`);

    const results = [];
    for (const f of files) {
        try {
            const st = statSync(f);
            if (st.size === 0) {
                results.push({
                    file: f,
                    oldName: path.basename(f),
                    newName: path.basename(f),
                    willRename: false,
                    playable: false,
                    zeroByte: true,
                });
                continue;
            }
        } catch {}
        const r = await processFile(f, opts);
        results.push(r);
    }

    console.log("\nRename & Check plan:\n");
    let okCount = 0,
        badCount = 0,
        renameCount = 0,
        delCount = 0;
    for (const r of results) {
        const status = r.playable ? "[OK] playable" : "[ERROR] broken";
        if (r.playable) okCount++;
        else badCount++;
        const action = r.willRename ? `-> "${r.newName}"` : "(no change)";
        console.log(`[${status}] ${r.oldName} ${action}`);
        if (r.willRename) renameCount++;
    }

    // Delete bad files if requested
    if (opts.deleteBad && badCount > 0) {
        console.log("\nDeleting broken/unplayable files...");
        for (const r of results.filter((r) => !r.playable)) {
            try {
                if (!opts.dryRun) {
                    await fs.unlink(r.file);
                    delCount++;
                    console.log(`Deleted: ${r.file}`);
                } else {
                    console.log(`[DRY-RUN] Would delete: ${r.file}`);
                }
            } catch (err) {
                console.error(`Failed to delete ${r.file}:`, err.message);
            }
        }
    }

    // Apply renames
    if (!opts.dryRun) {
        for (const r of results) {
            if (r.willRename && r.playable) {
                const oldPath = r.file;
                const newPath = path.join(path.dirname(r.file), r.newName);
                try {
                    await fs.rename(oldPath, newPath);
                } catch (e) {
                    console.error(
                        `Rename failed: "${r.oldName}" -> "${r.newName}":`,
                        e.message
                    );
                }
            }
        }
    } else {
        console.log("\n(DRY RUN) No renames or deletions will be performed.");
    }

    console.log(
        `\nSummary: ${okCount} playable, ${badCount} broken. ${renameCount} renamed${
            opts.deleteBad ? `, ${delCount} deleted` : ""
        }. ${opts.dryRun ? "(preview only)" : ""}`
    );
}

main().catch((e) => {
    console.error("Unexpected error:", e);
    process.exit(1);
});
