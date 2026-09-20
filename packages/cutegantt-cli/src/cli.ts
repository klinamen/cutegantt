#!/usr/bin/env node
import { main } from './main.js';
import { CommanderError } from 'commander';

try {
  main();
} catch (caught) {
  if (caught instanceof CommanderError) process.exitCode = caught.exitCode;
  else {
    console.error(`error: ${caught instanceof Error ? caught.message : String(caught)}`);
    process.exitCode = 1;
  }
}
