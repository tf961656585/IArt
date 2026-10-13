#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const COMPONENT_TO_MEDIA_KIND = {
  imageUpload: 'image',
  videoUpload: 'video',
  audioUpload: 'audio',
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function parseArgs(argv) {
  const args = { root: process.cwd() };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) {
      args.root = argv[++i];
    }
  }
  return args;
}

function getModelSourceDirs(root) {
  const sourcesDir = path.join(root, '.model-assets', 'sources');
  if (!fs.existsSync(sourcesDir)) {
    return [];
  }
  return fs.readdirSync(sourcesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(sourcesDir, d.name));
}

function collectMediaKindsFromFields(fields) {
  const kinds = new Set();
  for (const field of fields) {
    const component = field.component;
    if (component && COMPONENT_TO_MEDIA_KIND[component]) {
      kinds.add(COMPONENT_TO_MEDIA_KIND[component]);
    } else if (component && component.endsWith('Upload') && !COMPONENT_TO_MEDIA_KIND[component]) {
      // Unrecognized upload component — warn but don't block
      return { kinds, unknownComponent: component };
    }
  }
  return { kinds, unknownComponent: null };
}

function checkModel(dirPath) {
  const configPath = path.join(dirPath, 'runtime_model.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }

  const config = readJson(configPath);
  const modelName = path.basename(dirPath);
  const issues = [];

  const capability = config.capability || {};
  const inputModalities = capability.input_modalities || [];
  const supportsReferenceMedia = capability.supports_reference_media;

  const parameterSchema = config.parameter_schema || {};
  const fields = parameterSchema.fields || [];

  const { kinds: requiredMediaKinds, unknownComponent } = collectMediaKindsFromFields(fields);

  if (unknownComponent) {
    issues.push({
      level: 'warning',
      message: `unknown upload component '${unknownComponent}' found in parameter_schema — extend COMPONENT_TO_MEDIA_KIND mapping if needed`,
    });
  }

  // Check: input_modalities must include all media kinds derived from upload components
  if (requiredMediaKinds.size > 0) {
    for (const kind of requiredMediaKinds) {
      if (!inputModalities.includes(kind)) {
        issues.push({
          level: 'error',
          message: `parameter_schema has upload component for '${kind}' but input_modalities ${JSON.stringify(inputModalities)} does not include '${kind}'`,
        });
      }
    }
  }

  // Check: supports_reference_media must be true when imageUpload is present
  if (requiredMediaKinds.has('image') && supportsReferenceMedia !== true) {
    issues.push({
      level: 'error',
      message: `parameter_schema has imageUpload component but supports_reference_media is ${supportsReferenceMedia} (expected true)`,
    });
  }

  return { modelName, issues };
}

function main() {
  const args = parseArgs(process.argv);
  const dirs = getModelSourceDirs(args.root);

  if (dirs.length === 0) {
    console.error('guard:model-input-modalities failed: no model source directories found in .model-assets/sources/');
    process.exit(1);
  }

  const allIssues = [];
  let _checked = 0;

  for (const dir of dirs) {
    const result = checkModel(dir);
    if (!result) continue;
    _checked++;
    for (const issue of result.issues) {
      allIssues.push({ model: result.modelName, ...issue });
    }
  }

  if (allIssues.some(i => i.level === 'error')) {
    console.error('guard:model-input-modalities failed:');
    for (const issue of allIssues) {
      if (issue.level === 'error') {
        console.error(`  ${issue.model}: ${issue.message}`);
      }
    }
    // Also print warnings if any
    for (const issue of allIssues) {
      if (issue.level === 'warning') {
        console.error(`  ${issue.model}: [WARNING] ${issue.message}`);
      }
    }
    process.exit(1);
  }

  // Print warnings even on success
  for (const issue of allIssues) {
    if (issue.level === 'warning') {
      console.error(`  ${issue.model}: [WARNING] ${issue.message}`);
    }
  }

  // Success — no output (consistent with other guards)
}

main();
