const AdmZip = require("adm-zip");
const path = require("path");
const fs = require("fs");

const zip = new AdmZip();

// Add files
zip.addLocalFile(path.join(__dirname, "index.js"));
zip.addLocalFile(path.join(__dirname, "package.json"));

// Add node_modules directory
if (fs.existsSync(path.join(__dirname, "node_modules"))) {
  zip.addLocalFolder(path.join(__dirname, "node_modules"), "node_modules");
}

// Write zip file
const zipPath = path.join(__dirname, "backend.zip");
zip.writeZip(zipPath);
console.log(`Successfully created ${zipPath}`);
