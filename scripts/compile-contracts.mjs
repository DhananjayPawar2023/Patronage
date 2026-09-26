import fs from 'node:fs';
import path from 'node:path';
import solc from 'solc';

const contractsDir = path.resolve('contracts', 'src');
const artifactsDir = path.resolve('contracts', 'artifacts');
const nodeModulesDir = path.resolve('node_modules');

if (!fs.existsSync(artifactsDir)) {
  fs.mkdirSync(artifactsDir, { recursive: true });
}

function findImports(importPath) {
  let targetPath;
  if (importPath.startsWith('@openzeppelin/')) {
    targetPath = path.join(nodeModulesDir, importPath);
  } else {
    targetPath = path.join(contractsDir, importPath);
  }

  try {
    const contents = fs.readFileSync(targetPath, 'utf8');
    return { contents };
  } catch (err) {
    return { error: `File not found: ${targetPath} (${err.message})` };
  }
}

const contractFiles = fs.readdirSync(contractsDir).filter((file) => file.endsWith('.sol'));

const sources = {};
for (const file of contractFiles) {
  const filePath = path.join(contractsDir, file);
  sources[file] = { content: fs.readFileSync(filePath, 'utf8') };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: {
      '*': {
        '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
      },
    },
  },
};

console.log('Compiling Solidity contracts...');
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let hasError = false;
if (output.errors) {
  for (const error of output.errors) {
    if (error.severity === 'error') {
      console.error('Compilation Error:', error.formattedMessage);
      hasError = true;
    } else {
      console.warn('Compilation Warning:', error.formattedMessage);
    }
  }
}

if (hasError) {
  console.error('Contract compilation failed.');
  process.exit(1);
}

for (const sourceFile in output.contracts) {
  for (const contractName in output.contracts[sourceFile]) {
    const contract = output.contracts[sourceFile][contractName];
    const artifact = {
      contractName,
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    };

    const outputPath = path.join(artifactsDir, `${contractName}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
    console.log(`Saved artifact: contracts/artifacts/${contractName}.json`);
  }
}

console.log('Contract compilation successful!');
