import { FixtureLoader } from './FixtureLoader';
import { ScenarioRunner } from './ScenarioRunner';
import { AssertionLayer } from './AssertionLayer';

export class RegressionBatchRunner {
  static async runPack(packFilename: string) {
    console.log(`\n==================================================`);
    console.log(`[PAPER-SOP-PT-1] REGRESSION BATCH RUNNER START`);
    console.log(`==================================================\n`);

    const pack = FixtureLoader.loadPack(packFilename);
    console.log(`Loaded Pack: ${pack.title} (${pack.phase})`);
    console.log(`Total Scenarios: ${pack.fixtures.length}\n`);

    let passedCount = 0;
    let failedCount = 0;

    for (const fixture of pack.fixtures) {
      console.log(`--- Running Scenario: ${fixture.scenario_id} ---`);
      console.log(`Title: ${fixture.meta.title}`);
      
      try {
        const actualResult = ScenarioRunner.run(fixture);
        const assertion = AssertionLayer.assertParity(fixture.expected, actualResult);

        if (assertion.pass) {
          console.log(`✅ PASS`);
          passedCount++;
        } else {
          console.log(`❌ FAIL`);
          console.log(`Errors:`);
          assertion.errors.forEach(err => console.log(`  - ${err}`));
          failedCount++;
        }
      } catch (error: any) {
        console.log(`❌ ERROR: ${error.message}`);
        failedCount++;
      }
      console.log();
    }

    console.log(`==================================================`);
    console.log(`REGRESSION BATCH COMPLETE`);
    console.log(`Total: ${pack.fixtures.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
    console.log(`==================================================\n`);
    
    return { passedCount, failedCount, total: pack.fixtures.length };
  }
}

// If run directly
import { fileURLToPath } from 'url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const resV2 = await RegressionBatchRunner.runPack('pack_v2.json');
    const resAux = await RegressionBatchRunner.runPack('pack_aux.json');
    if (resV2.failedCount > 0 || resAux.failedCount > 0) process.exit(1);
    process.exit(0);
  })();
}
