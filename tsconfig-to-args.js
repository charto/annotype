#!/usr/bin/env node

// Usage: tsconfig-to-args.js | tsc @/dev/stdout

var fs = require('fs');

// Read and parse tsconfig.json in current working directory.

var config = JSON.parse(fs.readFileSync('tsconfig.json', 'utf-8'));

// Print command line parameters from compilerOptions in long format.

process.stdout.write(Object.keys(config.compilerOptions).map(function(key) {
	var arg = config.compilerOptions[key];

	if(arg===false) return('');
	if(arg===true) return('--' + key);

	return('--' + key + ' ' + arg);
}).join('\n') + '\n');

// Print source file names.

process.stdout.write(config.files.join('\n') + '\n');
