const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const newVersion = process.argv[2];

if (!newVersion) {
    console.error('Bitte eine Versionsnummer angeben! Beispiel: npm run release 2.62');
    process.exit(1);
}

// Ensure the version format matches expected conventions
if (!/^\d+\.\d+$/.test(newVersion) && !/^\d+\.\d+\.\d+$/.test(newVersion)) {
    console.warn(`Warnung: Version ${newVersion} sieht ungewöhnlich aus. Format ist normalerweise X.YY.`);
}

console.log(`🚀 Starte Release-Prozess für Version ${newVersion}...`);

const rootDir = path.join(__dirname, '..');

// 1. Update package.json
const packageJsonPath = path.join(rootDir, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log('✅ package.json aktualisiert');

// 2. Update manifest.json
const manifestJsonPath = path.join(rootDir, 'manifest.json');
const manifestJson = JSON.parse(fs.readFileSync(manifestJsonPath, 'utf8'));
manifestJson.version = newVersion;
fs.writeFileSync(manifestJsonPath, JSON.stringify(manifestJson, null, 2) + '\n');
console.log('✅ manifest.json aktualisiert');

// 3. Update updates.json
const updatesJsonPath = path.join(rootDir, 'updates.json');
const updatesJson = JSON.parse(fs.readFileSync(updatesJsonPath, 'utf8'));
// Assuming the structure is known
if (updatesJson.addons && updatesJson.addons["dora@lib4ri.ch"] && updatesJson.addons["dora@lib4ri.ch"].updates) {
    updatesJson.addons["dora@lib4ri.ch"].updates[0].version = newVersion;
    fs.writeFileSync(updatesJsonPath, JSON.stringify(updatesJson, null, 2) + '\n');
    console.log('✅ updates.json aktualisiert');
} else {
    console.warn('⚠️ updates.json konnte nicht geparst werden.');
}

// 4. Update content.js (first line usually)
const contentJsPath = path.join(rootDir, 'content.js');
let contentJs = fs.readFileSync(contentJsPath, 'utf8');
contentJs = contentJs.replace(/\/\/ Version: \d+\.\d+/, `// Version: ${newVersion}`);
fs.writeFileSync(contentJsPath, contentJs);
console.log('✅ content.js aktualisiert');

// 5. Git Commit & Tag
const tagName = `v.${newVersion}beta`;
const commitMessage = `chore: Release ${tagName}`;

try {
    console.log('📦 Führe Git-Befehle aus...');
    execSync('git add package.json manifest.json updates.json content.js', { cwd: rootDir, stdio: 'inherit' });
    execSync(`git commit -m "${commitMessage}"`, { cwd: rootDir, stdio: 'inherit' });
    execSync(`git tag ${tagName}`, { cwd: rootDir, stdio: 'inherit' });
    
    console.log('🚀 Pushe Änderungen zu GitHub...');
    execSync('git push origin HEAD', { cwd: rootDir, stdio: 'inherit' });
    execSync(`git push origin ${tagName}`, { cwd: rootDir, stdio: 'inherit' });
    
    console.log(`🎉 Erfolgreich! Tag ${tagName} wurde hochgeladen.`);
    console.log(`Die GitHub Action wird jetzt automatisch starten und das Release erstellen.`);
} catch (error) {
    console.error('❌ Fehler bei Git-Befehlen:', error.message);
    console.error('Bitte prüfe deinen Git-Status.');
    process.exit(1);
}
