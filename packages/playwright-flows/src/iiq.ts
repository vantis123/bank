/**
 * IdentityIQ capture flow.
 *
 *   1. Login at member.identityiq.com
 *   2. If a security-question page appears, fill the visible non-password
 *      input with the user's last-4 SSN (their security answer is always last 4).
 *   3. Navigate to /CreditReport.aspx, scroll to load lazy content.
 *   4. Capture body innerText.
 */

import { sleep, scrollPass, snap } from "./util.ts";
import type { CaptureSource, FlowContext } from "./types.ts";

export async function iiqLogin(
  ctx: FlowContext,
  username: string,
  password: string,
  last4: string | undefined
) {
  const page = ctx.page;

  ctx.log("  -> Navigating to member.identityiq.com");
  await page.goto("https://member.identityiq.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(3000);

  ctx.log("  -> Filling credentials");
  await page.waitForSelector("#txtUsername", { state: "visible", timeout: 20000 });
  await page.fill("#txtUsername", username);
  await sleep(500);
  await page.fill("#txtPassword", password);
  await sleep(700);

  await page.click("#imgBtnLogin");

  try {
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 25000 });
  } catch {
    await sleep(7000);
  }
  await sleep(3000);

  const url = page.url();
  if (url.includes("security") || url.includes("verify")) {
    ctx.log("  -> Security page detected — supplying last 4 SSN");
    if (!last4) {
      throw new Error("IIQ requires last4 SSN for the security challenge but none was provided");
    }

    await page.waitForSelector("input:visible", { timeout: 10000 }).catch(() => {});
    await sleep(1000);

    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("input")).map((i) => ({
        type: i.type,
        id: i.id,
        name: i.name,
        visible: i.offsetParent !== null && i.offsetWidth > 0,
      }));
    });

    const target = inputs.find(
      (i) =>
        i.visible &&
        !["hidden", "submit", "button", "checkbox", "radio", "password"].includes(i.type)
    );

    if (target) {
      const sel = target.id ? `#${target.id}` : `input[name="${target.name}"]`;
      await page.fill(sel, last4);
    } else {
      await page.keyboard.press("Tab");
      await sleep(300);
      await page.keyboard.type(last4, { delay: 80 });
    }
    await sleep(600);

    let submitted = false;
    for (const sel of [
      'button:has-text("Submit")',
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Verify")',
    ]) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          submitted = true;
          break;
        }
      } catch {}
    }
    if (!submitted) {
      await page.keyboard.press("Enter");
    }

    try {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      await sleep(8000);
    }
    await sleep(3000);
    ctx.log(`  -> Post-security URL: ${page.url()}`);
  }

  ctx.log(`  -> Logged in. URL: ${page.url()}`);
}

export async function iiqCaptureReport(
  ctx: FlowContext
): Promise<{ text: string; source: CaptureSource; pdfPath?: string }> {
  const page = ctx.page;

  ctx.log("  -> Navigating to /CreditReport.aspx");
  await page.goto("https://member.identityiq.com/CreditReport.aspx", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await sleep(10000);
  await snap(ctx, page, "iiq-credit-report-initial");

  ctx.log("  -> Scrolling to trigger lazy content");
  await scrollPass(page, 25);
  await sleep(5000);

  await page.emulateMedia({ media: "screen" });
  const pdfPath = `${ctx.sandboxDir}/iiq-credit-report-${Date.now()}.pdf`;
  await page.pdf({
    path: pdfPath,
    format: "Letter",
    printBackground: true,
    margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" },
  });
  ctx.log(`  -> Archival PDF: ${pdfPath}`);

  const text = await page.evaluate(() => document.body?.innerText || "");
  return { text, source: "iiq-credit-report", pdfPath };
}
