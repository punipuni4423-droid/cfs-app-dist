import { expect, test } from "@playwright/test";

test("uses the shared PDU default for a new browser profile", async ({ page }) => {
  await page.goto("/settings/devices");
  await page.evaluate(() => window.localStorage.removeItem("cfs-app-settings-v3"));
  await page.reload({ waitUntil: "networkidle" });

  const vaPerPdu = page.getByRole("textbox", { name: "VA / PDU", exact: true });
  await expect(vaPerPdu).toHaveValue("3.3");
});
