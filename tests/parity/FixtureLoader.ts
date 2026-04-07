import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class FixtureLoader {
  static loadPack(packFilename: string): any {
    const packPath = path.join(__dirname, 'fixtures', packFilename);
    const packData = JSON.parse(fs.readFileSync(packPath, 'utf-8'));
    
    const fixtures = packData.fixtures.map((fixtureFile: string) => {
      const fixturePath = path.join(__dirname, 'fixtures', fixtureFile);
      return JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    });
    
    return {
      pack_id: packData.pack_id,
      title: packData.title,
      phase: packData.phase,
      fixtures
    };
  }
}
