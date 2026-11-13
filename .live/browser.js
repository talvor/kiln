const { Builder, By, until } = require('./automation/node_modules/selenium-webdriver');
const firefox = require('./automation/node_modules/selenium-webdriver/firefox');
(async () => {
  const opts = new firefox.Options().addArguments('-headless');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(opts).build();
  try {
    await driver.get(process.argv[2]);
    const health = await driver.wait(until.elementLocated(By.css('#strip a[href="/health"]')), 15000);
    await driver.wait(until.elementIsVisible(health), 15000);
    console.log('home strip: ' + await driver.findElement(By.id('strip')).getText());
    await driver.takeScreenshot().then(b => require('fs').writeFileSync(process.argv[3] + '/healthy-home.png', b, 'base64'));
    await health.click();
    await driver.wait(until.urlContains('/health'), 5000);
    await driver.wait(until.elementLocated(By.xpath("//main//*[contains(text(),'pid ')]")), 10000);
    console.log('health initial: ' + await driver.findElement(By.id('main')).getText());
    await driver.takeScreenshot().then(b => require('fs').writeFileSync(process.argv[3] + '/health-initial.png', b, 'base64'));
    const run = await driver.findElement(By.xpath("//main//button[text()='Run checks']"));
    await run.click();
    await driver.wait(until.elementLocated(By.css('#main .health-list .check-ok')), 30000);
    console.log('health checks: ' + await driver.findElement(By.id('main')).getText());
    await driver.takeScreenshot().then(b => require('fs').writeFileSync(process.argv[3] + '/health-checks.png', b, 'base64'));
    await driver.findElement(By.xpath("//main//button[text()='Halt']")).click();
    await driver.wait(until.elementLocated(By.xpath("//main//button[text()='Resume']")), 10000);
    console.log('halted: ' + await driver.findElement(By.id('main')).getText());
    await driver.takeScreenshot().then(b => require('fs').writeFileSync(process.argv[3] + '/health-halted.png', b, 'base64'));
    await driver.findElement(By.xpath("//main//button[text()='Resume']")).click();
    await driver.wait(until.elementLocated(By.xpath("//main//button[text()='Halt']")), 10000);
    console.log('resumed: ' + await driver.findElement(By.id('main')).getText());
  } finally { await driver.quit(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
