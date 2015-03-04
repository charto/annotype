/// <reference path="typings/node/node.d.ts" />
/// <reference path="typings/typescript/typescript.d.ts" />

import ts = require('typescript');
import fs = require('fs');

var outputs: any = [];

var options: ts.CompilerOptions = {
	module: ts.ModuleKind.CommonJS,
	noImplicitAny: true,
	target: ts.ScriptTarget.ES5
};

var host = ts.createCompilerHost(options);

host.getSourceFile=function(fileName, languageVersion) {
	var content = fs.readFileSync(fileName, 'utf-8');

	return(ts.createSourceFile(fileName, content, options.target, true));
};

host.writeFile=function (name, text, writeByteOrderMark) {
	outputs.push({ name: name, text: text, writeByteOrderMark: writeByteOrderMark });
};

host.getNewLine=function () {return('\n');};

var fileNames = process.argv.slice(2);

var program = ts.createProgram(fileNames, options, host);
var errors = program.getGlobalDiagnostics();

if(errors && errors.length>0) console.error(errors);

var foo: any = {};

function annotateClassMembers(classDecl: ts.ClassDeclaration, checker: any) {
	var memberTbl = classDecl.symbol.members;
	var content = Object.keys(memberTbl).map((key) => {
		var valueDecl = memberTbl[key].valueDeclaration;
		if(valueDecl && valueDecl.kind == ts.SyntaxKind.PropertyDeclaration) {
			var propDecl = <ts.PropertyDeclaration>valueDecl;
			var type = checker.getTypeAtLocation(propDecl.type);

			return(
				'/** @type {' + checker.typeToString(type) + '} */\n' +
				'__DECLARE__(\'' + key + '\');'
			);
		}
	}).join('\n');

	return(content);
}

function annotateParameters(signatureDecl: ts.SignatureDeclaration, checker: any) {
	var paramList = signatureDecl.parameters;
	var content = paramList.map(function(param) {
		var type = checker.getTypeAtLocation(param);

		return(
			'  * @param {' +
			checker.typeToString(type) +
			'} ' + (<ts.Identifier>param.name).text
		);
	}).join('\n');

	return(content);
}

function annotate(node: ts.Node) {
	var changeList: any = [];
	var classDecl: ts.ClassDeclaration;
	var constructorFound: boolean;

	function parse(node : ts.Node) {
		var content: string;

		switch(node.kind) {
			case ts.SyntaxKind.Constructor:
				// checker.getTypeAtLocation(nd
				var constructDecl = <ts.ConstructorDeclaration>node.symbol.declarations[0];

				content = '/** @constructor\n';
				content += annotateParameters(constructDecl, checker);
				content += ' */\n';

				changeList.push({
					pos: node.getStart(),
					content: content
				});

				changeList.push({
					pos: constructDecl.body.getStart()+1,
					content: '\n' + annotateClassMembers(classDecl, checker)
				});

				constructorFound = true;

				ts.forEachChild(node, parse);
				break;
			case ts.SyntaxKind.MethodDeclaration:
				var methodDecl = <ts.MethodDeclaration>node.symbol.valueDeclaration;
				var type = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(methodDecl));

				content = '/** @returns {';
				content += checker.typeToString(type);
				content += '}\n';

				content += annotateParameters(methodDecl, checker);
				content += ' */\n';

				changeList.push({
					pos: node.getStart(),
					content: content
				});

				ts.forEachChild(node, parse);
				break;
			case ts.SyntaxKind.ClassDeclaration:
				classDecl = <ts.ClassDeclaration>node.symbol.valueDeclaration;
				var className = classDecl.name.text;

//ts.NodeFlags.Public

				changeList.push({
					pos: node.getStart(),
					content: '//__UNWRAPSTART__(' + className + ')\n'
				});

				changeList.push({
					pos: node.getEnd(),
					content: '//__UNWRAPEND__(' + className + ')\n'
				});

				ts.forEachChild(node, parse);

				if(!constructorFound && classDecl.members.length > 0) {
					changeList.push({
						pos: classDecl.members[0].getStart(),
						content: '/** @constructor */\n' +
							'constructor () {\n' +
							annotateClassMembers(classDecl, checker) +
							'\n}\n'
					});
				}

				break;
			default:
//				console.log(node.symbol.getDocumentationComment());
//				console.log((node.symbol?node.symbol.name:'')+'\t'+ts.SyntaxKind[node.kind]);
				ts.forEachChild(node, parse);
		}
	}

	parse(node);

	changeList.sort(function(a: any, b: any) {return(a.pos-b.pos);});

	var content = node.getSourceFile().getFullText();
	var changeCount = changeList.length;
	var pos: number = 0, posNext: number;
	var partList: any = [];

	for(var changeNum=0; changeNum<changeCount; changeNum++) {
		posNext = changeList[changeNum].pos;

		partList.push(content.substr(pos, posNext-pos), changeList[changeNum].content);

		pos = posNext;
	}

	partList.push(content.substr(pos));

/*
	ts.updateSourceFile(node.getSourceFile(), contentNew, {
		span:{start: 0, length: content.length},
		newLength: contentNew.length
	});
*/

	return({
		fileName: node.getSourceFile().fileName,
		content: partList.join('')
	});
}

var checker=program.getTypeChecker();

var parsedTbl = program.getSourceFiles().map(annotate).reduce(function(obj: any, item: any, pos: any) {
	obj[item.fileName] = item;
	return(obj);
},{});

host.getSourceFile=function(fileName, languageVersion) {
	return ts.createSourceFile(fileName, parsedTbl[fileName].content, options.target, true);
};

var program = ts.createProgram(fileNames, options, host);
var errors = program.getGlobalDiagnostics();

if(errors && errors.length>0) console.error(errors);

program.emit();

var errors = program.getGlobalDiagnostics();

if(errors && errors.length>0) console.error(errors);

outputs.forEach(function(output: any) {
	var content: string = output.text;

	// Remove CommonJS wrapping that may confuse Closure Compiler.
	content = content.replace(
		/\/\/__UNWRAPSTART__\(([^)]+)\)\s*var\s+([^\s=]+)\s*=\s*\(function\s*\(\s*\)\s*\{\s*/gm,
		(match: string, ...args: any[]) => {
			if(args[0] != args[1]) return(match);
			return('');
		}
	).replace(
		/return(?:\s*\(\s*|\s+)([^\s;)]+)\s*\)?\s*;?\s*}\s*\)\s*\(\s*\)\s*\;\s*\/\/__UNWRAPEND__\(([^)]+)\)\s*module\.exports\s*=\s*([^\s;]+)\s*;?/gm,
		(match: string, ...args: any[]) => {
			if(args[0] != args[1] || args[0] != args[2]) return(match);
			return('');
		}
	);

	// Add noop variable references to constructors, for defining types.
	content = content.replace(
		/__DECLARE__\s*\(\s*['"]([^']+)['"]\s*\)/gm,
		'this.$1'
	);

	process.stdout.write(content);
});
