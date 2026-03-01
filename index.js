import puppeteer from "puppeteer";
import 'dotenv/config';

const USERNAME = process.env.MYCLASS_USER;
const PASSWORD = process.env.MYCLASS_PASS;

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
    page.setDefaultTimeout(30000);
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
    await page.waitForSelector("a.joinBtn", { visible: true });
    await page.click("a.joinBtn");

    await page.waitForSelector("iframe");
    const iframeElement = await page.$("iframe");
    const frame = await iframeElement.contentFrame();
    return frame;
}

async function connectAudio(frame) {
    await frame.waitForSelector("button[aria-label='Listen only']", { visible: true });
    await frame.click("button[aria-label='Listen only']");
}

async function stayInMeeting(durationMinutes) {
    console.log(`⏳ Staying in meeting for ${durationMinutes} minutes...`);
    await sleep(durationMinutes * 60 * 1000);
}

async function pollForMeetingStart(page, intervalMs = 3000) {
    let joined = false;
    while (!joined) {
        const btn = await page.$("a.joinBtn"); // check if the button is there
        if (btn) {
            await btn.click(); // click to join the meeting
            joined = true;
            console.log("🔗 Joined meeting!");
        } else {
            console.log("Waiting for the meeting to start...");
            await sleep(intervalMs);
            await page.reload({ waitUntil: "networkidle2" });
        }
    }
}

async function main(startTime) {
    const { browser, page } = await launchBrowser();
    try {
        await loginToMyClass(page);
        await navigateToMeetings(page);
        await selectMeeting(page, startTime);

        await pollForMeetingStart(page); // poll until meeting starts

        const frame = await joinMeetingFrame(page);
        await connectAudio(frame);

        console.log(`✅ Successfully joined meeting at ${startTime}`);
        await stayInMeeting(130); // 2h10m

    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await browser.close();
    }
}

main("7:00");