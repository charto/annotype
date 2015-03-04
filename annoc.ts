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

function emitType(type: ts.Type, checker: any): string {
	var txt: string;

	if(type.flags & ts.TypeFlags.Intrinsic) {
		if(type.flags & ts.TypeFlags.Any) return('*');
		return((<ts.IntrinsicType>type).intrinsicName);
	}

	if(type.flags & ts.TypeFlags.StringLiteral) return('string');

	if(type.flags & ts.TypeFlags.Reference) {
		var refType = <ts.TypeReference>type;
		if(refType.target.symbol.name == 'Array') {
			return('Array.<' + emitType(refType.typeArguments[0], checker) + '>');
		} else return(emitType(refType.typeArguments[0], checker));
	}

	if(type.flags & (ts.TypeFlags.Enum | ts.TypeFlags.Class | ts.TypeFlags.Interface)) {
		return(type.symbol.name);
	}

    if (type.flags & ts.TypeFlags.Union) {
		return('(' + (<ts.UnionType>type).types.map((type) => emitType(type, checker)).join('|') + ')');
    }

	console.error('Unimplemented type ' + type.flags + '\t' + checker.typeToString(type));

	return(type.flags + '?');
}

function annotateClassMembers(classDecl: ts.ClassDeclaration, checker: any) {
	var memberTbl = classDecl.symbol.members;
	var content = Object.keys(memberTbl).map((key) => {
		var valueDecl = memberTbl[key].valueDeclaration;
		if(valueDecl && valueDecl.kind == ts.SyntaxKind.PropertyDeclaration) {
			var propDecl = <ts.PropertyDeclaration>valueDecl;
			var type = checker.getTypeAtLocation(propDecl.type);

			return(
				'/** @type {' + emitType(type, checker) + '} */\n' +
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
			emitType(type, checker) +
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
			case ts.SyntaxKind.FunctionDeclaration:
				var functionDecl = <ts.FunctionDeclaration>node.symbol.declarations[0];
				var type = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(functionDecl));

				content = '/** @returns {';
				content += emitType(type, checker);
				content += '}\n';
				content += annotateParameters(functionDecl, checker);
				content += ' */\n';

				changeList.push({
					pos: node.getStart(),
					content: content
				});

				ts.forEachChild(node, parse);
				break;
			case ts.SyntaxKind.Constructor:
				var constructDecl = <ts.ConstructorDeclaration>node.symbol.declarations[0];

				content = '/** @constructor\n';
				content += annotateParameters(constructDecl, checker);
				content += ' */\n';

				changeList.push({
					pos: node.getStart(),
					content: content
				});

				var bodyPos: number;

				if(constructDecl.body) {
					changeList.push({
						pos: constructDecl.body.getStart() + 1,
						content: '\n' + annotateClassMembers(classDecl, checker)
					});
				} else {
					changeList.push({
						pos: constructDecl.getEnd() - 1,
						content: '{\n' + annotateClassMembers(classDecl, checker) + '}\n'
					});
				}

				constructorFound = true;

				ts.forEachChild(node, parse);
				break;
			case ts.SyntaxKind.MethodDeclaration:
				var methodDecl = <ts.MethodDeclaration>node.symbol.valueDeclaration;
				var type = checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(methodDecl));

				content = '/** @returns {';
				content += emitType(type, checker);
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

				changeList.push({
					pos: node.getStart(),
					content: '//__UNWRAPSTART__(' + className + ')\n'
				});

				changeList.push({
					pos: node.getEnd(),
					content: '//__UNWRAPEND__(' + className + ')\n'
				});

				constructorFound = false;

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
