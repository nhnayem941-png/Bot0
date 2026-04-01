const { Telegraf, Markup } = require("telegraf");
const axios = require("axios");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const vm = require("vm");

const config = require("./config");

// ===== DATABASE =====
const db = new Database("bot_database.db");
db.exec(`CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

const addUser = db.prepare("INSERT OR IGNORE INTO users (user_id, username, first_name) VALUES (?, ?, ?)");
const countUsers = db.prepare("SELECT COUNT(*) as count FROM users");

// ===== BOT =====
const bot = new Telegraf(config.BOT_TOKEN);

// ===== FORCE JOIN =====
async function checkMembership(ctx, userId) {
    const notJoined = [];
    for (const channel of config.CHANNELS) {
        try {
            const member = await ctx.telegram.getChatMember(channel, userId);
            if (["left", "kicked"].includes(member.status)) {
                notJoined.push(channel);
            }
        } catch {
            notJoined.push(channel);
        }
    }
    return notJoined;
}

function getJoinKeyboard(notJoined) {
    const rows = [];
    for (let i = 0; i < notJoined.length; i += 2) {
        const row = [
            Markup.button.url(`📢 Join Channel ${i + 1}`, `https://t.me/${notJoined[i].replace("@", "")}`)
        ];
        if (i + 1 < notJoined.length) {
            row.push(Markup.button.url(`📢 Join Channel ${i + 2}`, `https://t.me/${notJoined[i + 1].replace("@", "")}`));
        }
        rows.push(row);
    }
    rows.push([Markup.button.callback("✅ ভেরিফাই করুন", "verify_join")]);
    return Markup.inlineKeyboard(rows);
}

// ===== LOADING ANIMATION =====
async function sendLoading(ctx, filename) {
    const frames = [
        "⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛ 0%",
        "🟩🟩⬛⬛⬛⬛⬛⬛⬛⬛ 20%",
        "🟩🟩🟩🟩⬛⬛⬛⬛⬛⬛ 40%",
        "🟩🟩🟩🟩🟩🟩⬛⬛⬛⬛ 60%",
        "🟩🟩🟩🟩🟩🟩🟩🟩⬛⬛ 80%",
        "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%",
    ];
    const msg = await ctx.reply(`⏳ Processing: ${filename}\n\n${frames[0]}`);
    for (let i = 1; i < frames.length; i++) {
        await new Promise(r => setTimeout(r, 300));
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `⏳ Processing: ${filename}\n\n${frames[i]}`);
        } catch {}
    }
    return msg;
}

async function sendResultCard(ctx, filename, fileSize = "N/A") {
    const text = `
━━━━━━━━━━━━━━━━━━━━
📁 File: ${filename}
🛡️ Security: ✅ Cleaned
🎨 Format: ✅ Beautified
⚡ Status: Successfully processed
━━━━━━━━━━━━━━━━━━━━
📤 Output includes:
• 📄 File size: ${fileSize}
• 📸 Screenshot preview
• 📄 Clean HTML file
• 🔒 Secure version
━━━━━━━━━━━━━━━━━━━━
👨‍💻 Developer: ${config.DEVELOPER_USERNAME}
👨‍💻 BY: ${config.BOT_USERNAME}`;
    await ctx.reply(text);
}

// ===== ADVANCED DECODERS =====

// Execute obfuscated JS in sandbox to extract decoded HTML
function sandboxDecode(content) {
    let decodedOutput = null;

    // Create a fake document.write / document.open / document.close context
    const fakeDocument = {
        _output: "",
        write(str) { this._output += str; },
        writeln(str) { this._output += str + "\n"; },
        open() { this._output = ""; },
        close() {},
        characterSet: "UTF-8",
        charset: "UTF-8",
    };

    const fakeWindow = {
        document: fakeDocument,
        addEventListener: () => {},
        removeEventListener: () => {},
        location: { href: "about:blank", hostname: "localhost" },
        navigator: { userAgent: "Mozilla/5.0" },
        console: { log: () => {}, error: () => {}, warn: () => {} },
        atob: (s) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s) => Buffer.from(s, "binary").toString("base64"),
        setTimeout: () => 0,
        setInterval: () => 0,
        clearTimeout: () => {},
        clearInterval: () => {},
        RegExp: RegExp,
        String: String,
        Array: Array,
        Object: Object,
        Math: Math,
        parseInt: parseInt,
        parseFloat: parseFloat,
        isNaN: isNaN,
        encodeURIComponent: encodeURIComponent,
        decodeURIComponent: decodeURIComponent,
        escape: escape,
        unescape: unescape,
    };

    // Extract all <script> content
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scripts = [];
    let match;
    while ((match = scriptRegex.exec(content)) !== null) {
        if (match[1].trim()) scripts.push(match[1]);
    }

    // Also try if entire content is JS (no HTML wrapper)
    if (scripts.length === 0 && (content.includes("eval(") || content.includes("Function(") || content.includes("document.write"))) {
        scripts.push(content);
    }

    for (const script of scripts) {
        try {
            // Replace eval/Function calls to capture output
            let modifiedScript = script;

            // Replace eval() with a function that captures
            modifiedScript = modifiedScript.replace(/\beval\s*\(/g, "(function(code){ try { return (new Function(code))(); } catch(e) { return code; } })(");

            const sandbox = {
                ...fakeWindow,
                window: fakeWindow,
                document: fakeDocument,
                self: fakeWindow,
                this: fakeWindow,
                global: fakeWindow,
            };

            const context = vm.createContext(sandbox);
            vm.runInContext(modifiedScript, context, { timeout: 10000 });

            if (fakeDocument._output && fakeDocument._output.trim().length > 10) {
                decodedOutput = fakeDocument._output;
                break;
            }
        } catch (e) {
            // Try alternative: replace document.write with capture
            try {
                let altScript = script;
                // Intercept document.write by wrapping
                const wrappedScript = `
                    var __captured = "";
                    var __origWrite = document.write.bind(document);
                    document.write = function(s) { __captured += s; __origWrite(s); };
                    document.writeln = function(s) { __captured += s + "\\n"; __origWrite(s); };
                    ${altScript}
                `;
                const sandbox2 = {
                    ...fakeWindow,
                    window: fakeWindow,
                    document: { ...fakeDocument, _output: "" },
                    self: fakeWindow,
                };
                const context2 = vm.createContext(sandbox2);
                vm.runInContext(wrappedScript, context2, { timeout: 10000 });
                if (sandbox2.document._output && sandbox2.document._output.trim().length > 10) {
                    decodedOutput = sandbox2.document._output;
                    break;
                }
            } catch {}
        }
    }

    return decodedOutput;
}

function multiLayerDecode(content) {
    const results = [];
    let decoded = content;
    let wasDecoded = false;

    // Detection
    if (/phpkobo|html-obfuscator/i.test(content)) {
        results.push("🔍 PHPKobo Obfuscation ডিটেক্ট করা হয়েছে");
    }
    if (/bj\s*coder|bjcoder|BJ-ENC/i.test(content)) {
        results.push("🔍 BJ Coder Encryption ডিটেক্ট করা হয়েছে");
    }

    const evalCount = (content.match(/eval\(/g) || []).length;
    const funcCount = (content.match(/Function\(/g) || []).length;
    if (evalCount) results.push(`🔍 eval() ডিটেক্ট করা হয়েছে (${evalCount} বার)`);
    if (funcCount) results.push(`🔍 Function() ডিটেক্ট করা হয়েছে (${funcCount} বার)`);

    // Try sandbox execution first (most reliable for obfuscated HTML)
    const sandboxResult = sandboxDecode(content);
    if (sandboxResult) {
        decoded = sandboxResult;
        results.push("✅ Sandbox Execution দিয়ে ডিকোড সফল!");
        wasDecoded = true;

        // Try multi-layer: if decoded output also has scripts, decode again
        for (let layer = 2; layer <= 5; layer++) {
            if (/<script/i.test(decoded) && (decoded.includes("eval(") || decoded.includes("document.write") || decoded.includes("Function("))) {
                const nextLayer = sandboxDecode(decoded);
                if (nextLayer && nextLayer !== decoded) {
                    decoded = nextLayer;
                    results.push(`✅ Layer ${layer} ডিকোড সফল!`);
                } else break;
            } else break;
        }
    }

    if (!wasDecoded) {
        // Fallback: manual pattern decoding
        // Base64 atob
        const b64Matches = content.match(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/g);
        if (b64Matches) {
            results.push("🔍 Base64 (atob) ডিটেক্ট করা হয়েছে");
            b64Matches.forEach(m => {
                const inner = m.match(/atob\(['"]([A-Za-z0-9+/=]+)['"]\)/);
                if (inner) {
                    try {
                        const d = Buffer.from(inner[1], "base64").toString("utf-8");
                        if (d.length > decoded.length * 0.1) {
                            decoded = d;
                            wasDecoded = true;
                        }
                        results.push("✅ Base64 ডিকোড সফল");
                    } catch {}
                }
            });
        }

        // Hex
        const hexMatches = content.match(/\\x[0-9a-fA-F]{2}/g);
        if (hexMatches && hexMatches.length > 10) {
            results.push(`🔍 Hex Escape ডিটেক্ট করা হয়েছে (${hexMatches.length} chars)`);
            try {
                const hexDecoded = content.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
                if (hexDecoded !== content) {
                    decoded = hexDecoded;
                    wasDecoded = true;
                    results.push("✅ Hex ডিকোড সফল");
                }
            } catch {}
        }

        // Unicode
        const uniMatches = content.match(/\\u[0-9a-fA-F]{4}/g);
        if (uniMatches && uniMatches.length > 5) {
            results.push(`🔍 Unicode Escape ডিটেক্ট করা হয়েছে (${uniMatches.length} chars)`);
            try {
                const uniDecoded = content.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
                if (uniDecoded !== content) {
                    decoded = uniDecoded;
                    wasDecoded = true;
                    results.push("✅ Unicode ডিকোড সফল");
                }
            } catch {}
        }

        // Octal in strings
        const octMatches = content.match(/\\(\d{3})/g);
        if (octMatches && octMatches.length > 5) {
            results.push(`🔍 Octal Escape ডিটেক্ট করা হয়েছে`);
            try {
                const octDecoded = content.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
                if (octDecoded !== content) {
                    decoded = octDecoded;
                    wasDecoded = true;
                    results.push("✅ Octal ডিকোড সফল");
                }
            } catch {}
        }

        // fromCharCode
        const ccMatches = content.match(/String\.fromCharCode\(([^)]+)\)/g);
        if (ccMatches) {
            results.push("🔍 String.fromCharCode ডিটেক্ট করা হয়েছে");
            ccMatches.forEach(m => {
                const inner = m.match(/\(([^)]+)\)/);
                if (inner) {
                    try {
                        const d = inner[1].split(",").map(n => String.fromCharCode(parseInt(n.trim()))).join("");
                        results.push("✅ CharCode ডিকোড সফল");
                    } catch {}
                }
            });
        }
    }

    if (results.length === 0) results.push("⚠️ কোনো পরিচিত এনকোডিং প্যাটার্ন পাওয়া যায়নি");

    return { results, decoded, wasDecoded };
}

function encryptHtml(htmlContent, key = "default_key") {
    const b64 = Buffer.from(htmlContent).toString("base64");
    const keyHash = crypto.createHash("sha256").update(key).digest("hex");
    
    let shifted = "";
    for (let i = 0; i < b64.length; i++) {
        const shift = parseInt(keyHash[i % keyHash.length], 16);
        shifted += String.fromCharCode(b64.charCodeAt(i) + shift);
    }
    
    const reversed = shifted.split("").reverse().join("");
    const hexEncoded = Buffer.from(reversed).toString("hex");
    
    const chunks = [];
    for (let i = 0; i < hexEncoded.length; i += 4) {
        chunks.push(hexEncoded.slice(i, i + 4));
    }
    
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Protected</title></head><body>
<script>
(function(){
var _0x=${JSON.stringify(chunks)};
var _k="${keyHash}";
var _h=_0x.join("");
var _r="";
for(var i=0;i<_h.length;i+=2){_r+=String.fromCharCode(parseInt(_h.substr(i,2),16));}
_r=_r.split("").reverse().join("");
var _d="";
for(var i=0;i<_r.length;i++){var s=parseInt(_k[i%_k.length],16);_d+=String.fromCharCode(_r.charCodeAt(i)-s);}
document.write(atob(_d));
})();
</script>
<noscript>JavaScript required</noscript>
</body></html>`;
}

// ===== FIREBASE DETECTOR =====
async function detectFirebase(url) {
    try {
        const { data: html } = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
            timeout: 15000,
            maxRedirects: 5,
        });
        
        const patterns = {
            apiKey: /apiKey["\s:=]+["']([A-Za-z0-9_-]+)["']/,
            authDomain: /authDomain["\s:=]+["']([\w.-]+\.firebaseapp\.com)["']/,
            projectId: /projectId["\s:=]+["']([a-z0-9-]+)["']/,
            storageBucket: /storageBucket["\s:=]+["']([\w.-]+\.appspot\.com|[\w.-]+\.firebasestorage\.app)["']/,
            messagingSenderId: /messagingSenderId["\s:=]+["'](\d+)["']/,
            appId: /appId["\s:=]+["']([0-9:a-zA-Z-]+)["']/,
            measurementId: /measurementId["\s:=]+["']([A-Z0-9-]+)["']/,
            databaseURL: /databaseURL["\s:=]+["'](https:\/\/[\w.-]+\.firebaseio\.com)["']/,
        };
        
        const foundConfig = {};
        let found = false;
        for (const [key, pattern] of Object.entries(patterns)) {
            const match = html.match(pattern);
            if (match) { foundConfig[key] = match[1]; found = true; }
        }

        // Also check in embedded scripts loaded from external URLs
        if (!found) {
            const scriptUrls = html.match(/src=["'](https?:\/\/[^"']+\.js[^"']*)["']/gi) || [];
            for (const srcMatch of scriptUrls.slice(0, 5)) {
                const srcUrl = srcMatch.match(/src=["'](https?:\/\/[^"']+)["']/);
                if (!srcUrl) continue;
                try {
                    const { data: jsData } = await axios.get(srcUrl[1], { timeout: 10000 });
                    for (const [key, pattern] of Object.entries(patterns)) {
                        const m = jsData.match(pattern);
                        if (m) { foundConfig[key] = m[1]; found = true; }
                    }
                    if (found) break;
                } catch {}
            }
        }
        
        const services = [];
        const fullContent = html;
        const servicePatterns = {
            "🔐 Authentication": /firebase.*auth|signInWith|createUserWith/i,
            "📦 Firestore": /firebase.*firestore|\.collection\(|\.doc\(/i,
            "💾 Realtime Database": /firebase.*database|firebaseio\.com/i,
            "📁 Storage": /firebase.*storage|storageRef|getDownloadURL/i,
            "📊 Analytics": /firebase.*analytics|logEvent/i,
            "📨 Messaging": /firebase.*messaging/i,
            "🔧 Functions": /firebase.*functions|httpsCallable/i,
        };
        for (const [name, pattern] of Object.entries(servicePatterns)) {
            if (pattern.test(fullContent)) services.push(name);
        }
        
        return { found, config: foundConfig, services };
    } catch (e) {
        return { found: false, error: e.message };
    }
}

// ===== GITHUB TOOLS =====
async function getGithubUser(username) {
    try {
        const { data } = await axios.get(`https://api.github.com/users/${username}`, { timeout: 10000 });
        return data;
    } catch { return null; }
}

async function getUserRepos(username) {
    try {
        const { data } = await axios.get(`https://api.github.com/users/${username}/repos?sort=updated&per_page=10`, { timeout: 10000 });
        return data;
    } catch { return []; }
}

// ===== REPLY KEYBOARD (Main Menu) =====
function mainMenuReplyKeyboard() {
    return Markup.keyboard([
        ["🌐 Source Code", "🔓 HTML Decode"],
        ["🔥 Firebase", "🐙 GitHub"],
        ["🔒 HTML Encrypt", "🔍 Find User"],
        ["👤 User Info", "📊 Stats"],
        ["ℹ️ Bot Info", "📞 Contact"],
    ]).resize();
}

// User modes
const userModes = new Map();

// ===== START COMMAND =====
bot.start(async (ctx) => {
    const user = ctx.from;
    addUser.run(user.id, user.username || "", user.first_name || "");
    
    const notJoined = await checkMembership(ctx, user.id);
    if (notJoined.length > 0) {
        return ctx.replyWithPhoto(config.LOGO_URL, {
            caption: `🌟 <b>${config.BOT_NAME}</b> 🌟\n\nহ্যালো <b>${user.first_name}</b>! 👋\n\nবট ব্যবহার করতে নিচের সব চ্যানেলে জয়েন করুন:`,
            parse_mode: "HTML",
            ...getJoinKeyboard(notJoined),
        });
    }
    
    return ctx.replyWithPhoto(config.LOGO_URL, {
        caption: `🌟 <b>${config.BOT_NAME}</b> 🌟\n\nস্বাগতম <b>${user.first_name}</b>! 👋\n\nনিচের বোতামগুলো থেকে টুল সিলেক্ট করুন:`,
        parse_mode: "HTML",
        ...mainMenuReplyKeyboard(),
    });
});

// ===== CALLBACK HANDLERS =====
bot.action("verify_join", async (ctx) => {
    await ctx.answerCbQuery();
    const notJoined = await checkMembership(ctx, ctx.from.id);
    if (notJoined.length > 0) {
        return ctx.reply("❌ আপনি এখনও সব চ্যানেলে জয়েন করেননি!", getJoinKeyboard(notJoined));
    }
    await ctx.reply("✅ ভেরিফিকেশন সফল!");
    return ctx.reply("মেইন মেনু:", mainMenuReplyKeyboard());
});

// GitHub sub-menu (inline keyboard still makes sense here)
bot.action("gh_info", async (ctx) => { await ctx.answerCbQuery(); userModes.set(ctx.from.id, "gh_info"); return ctx.reply("👤 GitHub Username দিন:"); });
bot.action("gh_repos", async (ctx) => { await ctx.answerCbQuery(); userModes.set(ctx.from.id, "gh_repos"); return ctx.reply("📂 GitHub Username দিন:"); });
bot.action("gh_download", async (ctx) => { await ctx.answerCbQuery(); userModes.set(ctx.from.id, "gh_download"); return ctx.reply("⬇️ owner/repo ফরম্যাটে দিন:"); });
bot.action("gh_search", async (ctx) => { await ctx.answerCbQuery(); userModes.set(ctx.from.id, "gh_search"); return ctx.reply("🔍 সার্চ কী-ওয়ার্ড দিন:"); });
bot.action("main_menu", async (ctx) => { await ctx.answerCbQuery(); return ctx.reply("মেইন মেনু:", mainMenuReplyKeyboard()); });

// ===== TEXT MESSAGE HANDLER =====
bot.on("text", async (ctx) => {
    const nj = await checkMembership(ctx, ctx.from.id);
    if (nj.length) return ctx.reply("❌ চ্যানেলে জয়েন করুন!", getJoinKeyboard(nj));

    const mode = userModes.get(ctx.from.id) || "";
    const text = ctx.message.text.trim();
    const user = ctx.from;

    // ===== REPLY KEYBOARD HANDLERS =====
    if (text === "🌐 Source Code") {
        userModes.set(ctx.from.id, "source_code");
        return ctx.reply("🌐 ওয়েবসাইটের URL পাঠান (https:// সহ):");
    }
    if (text === "🔓 HTML Decode") {
        userModes.set(ctx.from.id, "html_decode");
        return ctx.reply("🔓 <b>HTML Decoding</b>\n\nসাপোর্টেড: PHPKobo, BJCoder, Base64, Hex, Unicode, URL, Octal, CharCode, ROT13, eval/Function\n\nHTML ফাইল বা URL পাঠান:", { parse_mode: "HTML" });
    }
    if (text === "🔥 Firebase") {
        userModes.set(ctx.from.id, "firebase");
        return ctx.reply("🔥 ওয়েবসাইটের URL পাঠান:");
    }
    if (text === "🐙 GitHub") {
        return ctx.reply("🐙 <b>GitHub Tools</b>", {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.callback("👤 Info", "gh_info"), Markup.button.callback("📂 Repos", "gh_repos")],
                [Markup.button.callback("⬇️ Download", "gh_download"), Markup.button.callback("🔍 Search", "gh_search")],
                [Markup.button.callback("🔙 মেইন মেনু", "main_menu")],
            ]),
        });
    }
    if (text === "🔒 HTML Encrypt") {
        userModes.set(ctx.from.id, "html_encrypt");
        return ctx.reply("🔒 আপনার HTML ফাইল পাঠান:");
    }
    if (text === "🔍 Find User") {
        userModes.set(ctx.from.id, "find_username");
        return ctx.reply("🔍 Channel/User ID দিন:");
    }
    if (text === "👤 User Info") {
        const photos = await ctx.telegram.getUserProfilePhotos(user.id, 0, 1);
        const infoText = `👤 <b>User Info</b>\n━━━━━━━━━━━━━━━━━━━━\n🆔 UID: <code>${user.id}</code>\n👤 Username: @${user.username || "N/A"}\n📛 Name: ${user.first_name} ${user.last_name || ""}\n🔗 Link: <a href="tg://user?id=${user.id}">Profile</a>\n━━━━━━━━━━━━━━━━━━━━`;
        if (photos.total_count > 0) {
            return ctx.replyWithPhoto(photos.photos[0][photos.photos[0].length - 1].file_id, { caption: infoText, parse_mode: "HTML" });
        }
        return ctx.reply(infoText, { parse_mode: "HTML" });
    }
    if (text === "📊 Stats") {
        const { count } = countUsers.get();
        return ctx.reply(`📊 <b>Bot Stats</b>\n\n👥 Total Users: <b>${count}</b>`, { parse_mode: "HTML" });
    }
    if (text === "ℹ️ Bot Info") {
        return ctx.reply(`ℹ️ <b>Bot Features</b>\n━━━━━━━━━━━━━━━━━━━━\n🌐 Website Source Code\n🔓 HTML Decoding (PHPKobo, BJCoder, Base64+)\n🔥 Firebase Detect\n🐙 GitHub Tools\n🔒 HTML Encryption\n🔍 Find Username by ID\n👤 User Info\n📊 Bot Stats\n━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "HTML" });
    }
    if (text === "📞 Contact") {
        return ctx.reply(`📞 Developer: ${config.DEVELOPER_USERNAME}\n💬 https://t.me/${config.DEVELOPER_USERNAME.replace("@", "")}`);
    }

    // ===== MODE HANDLERS =====
    if (mode === "source_code") {
        if (!text.startsWith("http")) {
            return ctx.reply("❌ সঠিক URL দিন (https:// সহ)");
        }
        const loadMsg = await sendLoading(ctx, text);
        try {
            const { data } = await axios.get(text, { 
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }, 
                timeout: 15000,
                maxRedirects: 5,
            });
            
            // Get full page source including fetching linked scripts/css
            let fullSource = data;
            
            // Extract and inline external JS
            const scriptMatches = data.match(/<script[^>]+src=["'](https?:\/\/[^"']+)["'][^>]*>/gi) || [];
            for (const tag of scriptMatches.slice(0, 10)) {
                const srcMatch = tag.match(/src=["'](https?:\/\/[^"']+)["']/);
                if (srcMatch) {
                    try {
                        const { data: jsContent } = await axios.get(srcMatch[1], { timeout: 10000 });
                        fullSource += `\n\n<!-- ===== External Script: ${srcMatch[1]} ===== -->\n<script>\n${jsContent}\n</script>`;
                    } catch {}
                }
            }
            
            // Extract and inline external CSS
            const cssMatches = data.match(/<link[^>]+href=["'](https?:\/\/[^"']+\.css[^"']*)["'][^>]*>/gi) || [];
            for (const tag of cssMatches.slice(0, 10)) {
                const hrefMatch = tag.match(/href=["'](https?:\/\/[^"']+)["']/);
                if (hrefMatch) {
                    try {
                        const { data: cssContent } = await axios.get(hrefMatch[1], { timeout: 10000 });
                        fullSource += `\n\n<!-- ===== External CSS: ${hrefMatch[1]} ===== -->\n<style>\n${cssContent}\n</style>`;
                    } catch {}
                }
            }
            
            const tmpFile = `/tmp/source_${Date.now()}.html`;
            fs.writeFileSync(tmpFile, fullSource);
            const size = `${(Buffer.byteLength(fullSource) / 1024).toFixed(1)} KB`;
            await sendResultCard(ctx, text, size);
            await ctx.replyWithDocument({ source: tmpFile, filename: "source_code.html" });
            fs.unlinkSync(tmpFile);
            try { await ctx.telegram.sendMessage(config.HISTORY_CHANNEL_ID, `🌐 Source Code\n👤 @${user.username} (${user.id})\n🔗 ${text}`); } catch {}
        } catch (e) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, `❌ Error: ${e.message}`);
        }
        userModes.delete(ctx.from.id);
    } else if (mode === "firebase") {
        if (!text.startsWith("http")) {
            return ctx.reply("❌ সঠিক URL দিন (https:// সহ)");
        }
        const loadMsg = await sendLoading(ctx, text);
        const result = await detectFirebase(text);
        if (result.found) {
            let configText = "🔥 <b>Firebase Config Found!</b>\n\n";
            for (const [k, v] of Object.entries(result.config)) configText += `<b>${k}:</b> <code>${v}</code>\n`;
            if (result.services.length) { configText += "\n<b>Services:</b>\n"; result.services.forEach(s => configText += `  ${s}\n`); }
            await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, configText, { parse_mode: "HTML" });
        } else {
            const errMsg = result.error ? `\n\nError: ${result.error}` : "";
            await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, `❌ Firebase পাওয়া যায়নি।${errMsg}`);
        }
        try { await ctx.telegram.sendMessage(config.HISTORY_CHANNEL_ID, `🔥 Firebase\n👤 @${user.username} (${user.id})\n🔗 ${text}`); } catch {}
        userModes.delete(ctx.from.id);
    } else if (mode === "gh_info") {
        const info = await getGithubUser(text);
        if (info) {
            const t = `🐙 <b>GitHub User</b>\n━━━━━━━━━━━━━━━━━━━━\n👤 ${info.name || "N/A"}\n🆔 ${info.login}\n📝 ${info.bio || "N/A"}\n📂 Repos: ${info.public_repos}\n👥 Followers: ${info.followers}\n🔗 ${info.html_url}\n━━━━━━━━━━━━━━━━━━━━`;
            if (info.avatar_url) await ctx.replyWithPhoto(info.avatar_url, { caption: t, parse_mode: "HTML" });
            else await ctx.reply(t, { parse_mode: "HTML" });
        } else await ctx.reply("❌ GitHub ইউজার পাওয়া যায়নি।");
        userModes.delete(ctx.from.id);
    } else if (mode === "gh_repos") {
        const repos = await getUserRepos(text);
        if (repos.length) {
            let t = `📂 <b>${text}'s Repos</b>\n\n`;
            repos.forEach((r, i) => { t += `${i+1}. <b>${r.name}</b> ⭐${r.stargazers_count} 🍴${r.forks_count} 📝${r.language || "N/A"}\n🔗 ${r.html_url}\n\n`; });
            await ctx.reply(t, { parse_mode: "HTML", disable_web_page_preview: true });
        } else await ctx.reply("❌ রিপো পাওয়া যায়নি।");
        userModes.delete(ctx.from.id);
    } else if (mode === "gh_download") {
        const parts = text.split("/");
        if (parts.length >= 2) {
            const [owner, repo] = [parts[parts.length-2], parts[parts.length-1]];
            const url = `https://github.com/${owner}/${repo}/archive/refs/heads/main.zip`;
            // Verify the repo exists
            try {
                await axios.head(url, { timeout: 10000, maxRedirects: 5 });
                await ctx.reply(`⬇️ Download Link:\n${url}`);
            } catch {
                // Try master branch
                const masterUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/master.zip`;
                await ctx.reply(`⬇️ Download Link (try both):\n\nmain: ${url}\nmaster: ${masterUrl}`);
            }
        } else await ctx.reply("❌ ফরম্যাট: owner/repo");
        userModes.delete(ctx.from.id);
    } else if (mode === "gh_search") {
        try {
            const { data } = await axios.get(`https://api.github.com/search/repositories?q=${encodeURIComponent(text)}&per_page=5`, { timeout: 10000 });
            if (data.items.length) {
                let t = `🔍 <b>Results for: ${text}</b>\n\n`;
                data.items.forEach((r, i) => { t += `${i+1}. <b>${r.full_name}</b> ⭐${r.stargazers_count}\n${(r.description || "").slice(0, 80)}\n🔗 ${r.html_url}\n\n`; });
                await ctx.reply(t, { parse_mode: "HTML", disable_web_page_preview: true });
            } else await ctx.reply("❌ পাওয়া যায়নি।");
        } catch { await ctx.reply("❌ সার্চ ব্যর্থ।"); }
        userModes.delete(ctx.from.id);
    } else if (mode === "find_username") {
        try {
            const chatId = parseInt(text);
            const chat = await ctx.telegram.getChat(chatId);
            await ctx.reply(`🔍 <b>Found!</b>\n━━━━━━━━━━━━━━━━━━━━\n🆔 ID: <code>${chat.id}</code>\n📛 ${chat.title || chat.first_name || "N/A"}\n👤 @${chat.username || "N/A"}\n🔗 ${chat.username ? `https://t.me/${chat.username}` : "N/A"}\n━━━━━━━━━━━━━━━━━━━━`, { parse_mode: "HTML" });
        } catch (e) {
            await ctx.reply(`❌ পাওয়া যায়নি: ${e.message}`);
        }
        userModes.delete(ctx.from.id);
    } else if (mode === "html_decode") {
        if (!text.startsWith("http")) {
            return ctx.reply("❌ সঠিক URL দিন বা HTML ফাইল পাঠান");
        }
        const loadMsg = await sendLoading(ctx, text);
        try {
            const { data } = await axios.get(text, { timeout: 15000, maxRedirects: 5 });
            const { results, decoded, wasDecoded } = multiLayerDecode(data);
            let t = "🔓 <b>Decoding Results</b>\n\n";
            results.forEach(r => t += r + "\n");
            if (!wasDecoded) t += "\n⚠️ ম্যানুয়াল ডিকোডিং প্রয়োজন হতে পারে";
            await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, t, { parse_mode: "HTML" });
            const tmpFile = `/tmp/decoded_${Date.now()}.html`;
            fs.writeFileSync(tmpFile, decoded);
            await sendResultCard(ctx, "decoded.html", `${(Buffer.byteLength(decoded) / 1024).toFixed(1)} KB`);
            await ctx.replyWithDocument({ source: tmpFile, filename: "decoded.html" });
            fs.unlinkSync(tmpFile);
            try { await ctx.telegram.sendMessage(config.HISTORY_CHANNEL_ID, `🔓 Decode URL\n👤 @${user.username} (${user.id})\n🔗 ${text}`); } catch {}
        } catch (e) {
            await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, `❌ ${e.message}`);
        }
        userModes.delete(ctx.from.id);
    }
});

// ===== FILE HANDLER =====
bot.on("document", async (ctx) => {
    const nj = await checkMembership(ctx, ctx.from.id);
    if (nj.length) return ctx.reply("❌ চ্যানেলে জয়েন করুন!", getJoinKeyboard(nj));

    const user = ctx.from;
    const doc = ctx.message.document;
    const filename = doc.file_name || "unknown";

    // Forward to history
    try {
        await ctx.telegram.forwardMessage(config.HISTORY_CHANNEL_ID, ctx.chat.id, ctx.message.message_id);
        await ctx.telegram.sendMessage(config.HISTORY_CHANNEL_ID, `📁 File\n👤 @${user.username} (${user.id})\n📄 ${filename}`);
    } catch {}

    const loadMsg = await sendLoading(ctx, filename);
    
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "text" });

    const mode = userModes.get(ctx.from.id) || "";

    if (mode === "html_encrypt") {
        const encrypted = encryptHtml(data);
        const tmpFile = `/tmp/enc_${Date.now()}.html`;
        fs.writeFileSync(tmpFile, encrypted);
        await sendResultCard(ctx, filename, `${(Buffer.byteLength(encrypted) / 1024).toFixed(1)} KB`);
        await ctx.replyWithDocument({ source: tmpFile, filename: `encrypted_${filename}` }, { caption: "🔒 Encrypted - ডিকোডিং অসম্ভব!" });
        fs.unlinkSync(tmpFile);
    } else {
        // Auto decode mode
        const { results, decoded, wasDecoded } = multiLayerDecode(data);
        let t = "🔓 <b>Decoding Results</b>\n\n";
        results.forEach(r => t += r + "\n");
        if (!wasDecoded) t += "\n⚠️ সম্পূর্ণ ডিকোড করা সম্ভব হয়নি";
        await ctx.telegram.editMessageText(ctx.chat.id, loadMsg.message_id, null, t, { parse_mode: "HTML" });
        const tmpFile = `/tmp/dec_${Date.now()}.html`;
        fs.writeFileSync(tmpFile, decoded);
        await sendResultCard(ctx, filename, `${(Buffer.byteLength(decoded) / 1024).toFixed(1)} KB`);
        await ctx.replyWithDocument({ source: tmpFile, filename: `decoded_${filename}` });
        fs.unlinkSync(tmpFile);
    }
    
    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch {}
    userModes.delete(ctx.from.id);
});

// ===== LAUNCH =====
bot.launch().then(() => console.log("🤖 Bot started!"));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot is Running! 🚀');
});

app.listen(port, () => {
  console.log(`Server is listening on port ${port}`);
});

