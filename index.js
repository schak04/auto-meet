import puppeteer from "puppeteer";
import 'dotenv/config';

const USERNAME = process.env.MYCLASS_USER;
const PASSWORD = process.env.MYCLASS_PASS;

// Step 0: Define schedule
const schedule = {
    1: ["7:00"], // 7pm to 8pm <- Monday
    2: ["7:00"], // 7pm to 8pm <- Tuesday
    3: ["7:00"], // 7pm to 8pm <- Wednesday
    4: ["7:00"], // 7pm to 8pm <- Thursday
    6: ["10:00"], // 10am to 12pm <- Saturday
    // 0=Sunday, 5=Friday have no meetings
};

// auto-check meeting time
function getNextMeeting() {
    const now = new Date();
    const day = now.getDay();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const todayMeetings = schedule[day] || [];
    for (let start of todayMeetings) {
        let [hourStr, minStr] = start.split(":");
        let hour = parseInt(hourStr);
        const min = parseInt(minStr) || 0;

        // Convert PM times (e.g., 7:00 pm → 19:00)
        if (hour === 7) hour = 19;

        if (currentHour < hour || (currentHour === hour && currentMinute <= min)) {
            return start; // next upcoming meeting
        }
    }
    return null; // no upcoming meetings
}

// helper: wait for X ms
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ["--start-maximized"]
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(30000); // default timeout for waits
    return { browser, page };
}

async function loginToMyClass(page) {
    await page.goto("https://myclass.lpu.in/", { waitUntil: "networkidle2" });
    await page.type("input[aria-label='user name']", USERNAME);
    await page.type("input[aria-label='password']", PASSWORD);
    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2" }),
        page.click("button.ghost-round.full-width")
    ]);
    console.log("✅ Logged in");
}

async function navigateToMeetings(page) {
    await page.waitForSelector("a[aria-label='View Classes and Meetings']", { visible: true });
    await page.click("a[aria-label='View Classes and Meetings']");
}

async function selectMeeting(page, startTime) {
    const meetingSelector = `div.fc-time[data-start='${startTime}']`;
    await page.waitForSelector(meetingSelector, { visible: true });
    await page.click(meetingSelector);
}

async function joinMeetingFrame(page) {
    await page.waitForSelector("iframe", { visible: true });
    const iframeElement = await page.$("iframe");
    const frame = await iframeElement.contentFrame();
    return frame;
}

async function pollForAudio(frame, intervalMs = 2000) {
    let connected = false;
    while (!connected) {
        const btn = await frame.$("button[aria-label='Listen only']");
        if (btn) {
            await btn.click();
            connected = true;
            console.log("🎧 Connected in Listen only mode");
        } else {
            await sleep(intervalMs);
        }
    }
}

// async function connectAudio(frame) {
//     await frame.waitForSelector("button[aria-label='Listen only']", { visible: true });
//     await frame.click("button[aria-label='Listen only']");
//     console.log("🎧 Connected in Listen only mode");
// }

async function stayInMeeting(durationMinutes) {
    console.log(`⏳ Staying in meeting for ${durationMinutes} minutes...`);
    await sleep(durationMinutes * 60 * 1000);
}

async function pollForMeetingStart(page, intervalMs = 4000) {
    console.log("⏳ Waiting for the meeting to start...");
    let joined = false;
    while (!joined) {
        const btn = await page.$("a.joinBtn"); // check if the button is there
        if (btn) {
            await btn.click(); // click to join the meeting
            joined = true;
            console.log("🔗 Join button detected! Joining now...");
        } else {
            console.log(`⏱ Meeting not ready yet, reloading in ${intervalMs/1000} seconds...`);
            await sleep(intervalMs);
            try {
                await page.reload({ waitUntil: "networkidle2" });
            } catch(e) {
                console.log("⚠️ Reload failed, retrying...");
            }
        }
    }
}

async function main() {
    const startTime = getNextMeeting();
    if (!startTime) {
        console.log("📅 No upcoming meetings today.");
        return;
    }
    console.log(`🎯 Next meeting is at ${startTime}`);

    const { browser, page } = await launchBrowser();
    try {
        await loginToMyClass(page);
        await navigateToMeetings(page);
        await selectMeeting(page, startTime);

        await pollForMeetingStart(page); // poll until join button appears

        const frame = await joinMeetingFrame(page);
        await pollForAudio(frame); // keep trying until "Listen only" button appears

        console.log(`✅ Successfully joined meeting at ${startTime}`);
        await stayInMeeting(130); // stay 2h10m

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await browser.close();
    }
}

main(); // automatically join meeting