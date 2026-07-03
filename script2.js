#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const chokidar = require('chokidar');
require('dotenv').config();
const sharp = require('sharp');

const localFolder = process.env.LOCAL_FOLDER;
const storageZoneName = process.env.BUNNYCDN_STORAGE_ZONE_NAME;
const apiKey = process.env.BUNNYCDN_API_KEY;
const errorLogFile = 'upload_errors.log';
const debounceDelay = 3000;
const stabilityCheckInterval = 1000;
let fileTimeouts = {};

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
  ssl: {
    rejectUnauthorized: false,
  },
});

async function fileExistsInBunny(destinationPath) {
  try {
    const fetch = await import('node-fetch').then((module) => module.default);
    const apiUrl = `https://se.storage.bunnycdn.com/${storageZoneName}/${destinationPath}`;

    const response = await fetch(apiUrl, {
      method: 'HEAD',
      headers: {
        AccessKey: apiKey,
      },
    });

    return response.ok;
  } catch (error) {
    console.error('BunnyCDN check error:', error);
    return false;
  }
}

async function fileExistsInDatabase(bunnyUrl) {
  try {
    const result = await pool.query('SELECT 1 FROM images WHERE image_url = $1', [bunnyUrl]);
    return result.rows.length > 0;
  } catch (error) {
    console.error('Database check error:', error);
    return false;
  }
}

async function uploadToBunny(filePath, destinationPath) {
  try {
    const fetch = await import('node-fetch').then((module) => module.default);
    const fileData = fs.readFileSync(filePath);
    const apiUrl = `https://se.storage.bunnycdn.com/${storageZoneName}/${destinationPath}`;

    const response = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        AccessKey: apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: fileData,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload to BunnyCDN: ${response.status}`);
    }
    console.log(`Uploaded: ${destinationPath}`);
  } catch (error) {
    console.error('Upload error:', error);
    logError(`Upload failed for: ${destinationPath} - ${error.message}`);
  }
}

async function updateDatabase(bunnyUrl, folderName, is10x15, filename, isPurchased) {
  try {
    await pool.query(
      'INSERT INTO images (folder_id, image_url, is_purchased, is10x15, image_name) VALUES ($1, $2, $3, $4, $5)',
      [folderName, bunnyUrl, isPurchased, is10x15, filename]
    );
  } catch (error) {
    console.error('Database update error:', error);
    logError(`Database update failed for: ${bunnyUrl} - ${error.message}`);
  }
}

async function processFile(filePath, filename, isPurchased, grandParentFolder) {
  try {
    const eventFolderName = grandParentFolder;
    const folderName = filename.split('-')[0];
    const bunnyPath = `${eventFolderName}/${folderName}/${filename}`;
    const bunnyUrl = `https://randavfotostuudio.b-cdn.net/${bunnyPath}`;

    if (await fileExistsInBunny(bunnyPath) && await fileExistsInDatabase(bunnyUrl)) {
      console.log(`Skipping existing file: ${filename}`);
      return;
    }

    const stats = fs.statSync(filePath);
    if (stats.size === 0) {
      console.warn(`Skipping empty file: ${filename}`);
      logError(`Skipped empty file: ${filename}`);
      return;
    }

    const metadata = await sharp(filePath).metadata();
    const aspectRatio = metadata.width / metadata.height;
    const is10x15 = aspectRatio < 1;

    await uploadToBunny(filePath, bunnyPath);
    await updateDatabase(bunnyUrl, folderName, is10x15, filename, isPurchased);

    console.log(`Processed: ${filename}, Purchased: ${isPurchased}`);
  } catch (error) {
    console.error('File processing error:', error);
    logError(`File processing failed for: ${filename} - ${error.message}`);
  }
}

function logError(errorMessage) {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp} - ${errorMessage}\n`;

  fs.appendFile(errorLogFile, logEntry, (err) => {
    if (err) {
      console.error('Failed to write to error log:', err);
    }
  });
}

function checkFileStability(filePath, filename, isPurchased, grandParentFolder) {
  let previousSize = -1;
  let checkCount = 0;
  const maxChecks = 30;
  const interval = setInterval(() => {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size === previousSize) {
        clearInterval(interval);
        processFile(filePath, filename, isPurchased, grandParentFolder);
      } else {
        previousSize = stats.size;
        checkCount++;
        if (checkCount >= maxChecks) {
          clearInterval(interval);
          console.warn(`File stability timeout: ${filename}`);
          logError(`File stability timeout: ${filename}`);
          processFile(filePath, filename, isPurchased, grandParentFolder);
        }
      }
    } catch (error) {
      clearInterval(interval);
      console.error(`Error checking file stability: ${error}`);
      logError(`Error checking file stability: ${error.message}`);
      processFile(filePath, filename, isPurchased, grandParentFolder);
    }
  }, stabilityCheckInterval);
}

function watchChildFolders(localFolderPath) {
  const watcher = chokidar.watch(path.join(localFolderPath), {
    ignored: /(^|[\\/\\\\])\../,
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
  });


  watcher.on('add', (filePath) => {
    console.log('File added:', filePath);
    const filename = path.basename(filePath);
    const parentFolder = path.basename(path.dirname(filePath));
    const grandParentFolder = path.basename(path.dirname(path.dirname(filePath)));
    const isPurchased = parentFolder === 'purchased';

    console.log(`File: ${filename}, Parent: ${parentFolder}, Grandparent: ${grandParentFolder}, Purchased: ${isPurchased}`);
    if (fileTimeouts[filename]) {
      clearTimeout(fileTimeouts[filename]);
    }

    fileTimeouts[filename] = setTimeout(() => {
      delete fileTimeouts[filename];
      checkFileStability(filePath, filename, isPurchased, grandParentFolder);
    }, debounceDelay);
  });

  watcher.on('error', (error) => {
    console.error('Chokidar error:', error);
  });
}

watchChildFolders(localFolder);
console.log(`Watching folder: ${localFolder}`);
