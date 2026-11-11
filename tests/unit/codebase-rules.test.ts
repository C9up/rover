/**
 * The source rules a review cannot be trusted to hold by eye: no `as T`
 * assertion (`as const` is fine), no `!` non-null assertion, no `any`, and no
 * identifier of ours starting with `_`. Read from the TypeScript AST, so a
 * comment or a string that mentions them does not count, and a new one fails
 * here with its file and line.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../..");
const srcDir = join(root, "src");

function sourceFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/** The names a declaration introduces: the ones the underscore rule is about. */
function declaredName(
	node: ts.Node,
): ts.Identifier | ts.PrivateIdentifier | undefined {
	if (
		ts.isParameter(node) ||
		ts.isVariableDeclaration(node) ||
		ts.isFunctionDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isPropertyDeclaration(node) ||
		ts.isPropertySignature(node) ||
		ts.isInterfaceDeclaration(node) ||
		ts.isTypeAliasDeclaration(node) ||
		ts.isBindingElement(node)
	) {
		const name = node.name;
		if (
			name !== undefined &&
			(ts.isIdentifier(name) || ts.isPrivateIdentifier(name))
		) {
			return name;
		}
	}
	return undefined;
}

function violations(file: string): string[] {
	const text = readFileSync(file, "utf8");
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const found: string[] = [];
	const report = (node: ts.Node, what: string) => {
		const { line } = source.getLineAndCharacterOfPosition(
			node.getStart(source),
		);
		found.push(`${relative(root, file)}:${line + 1} ${what}`);
	};
	const visit = (node: ts.Node): void => {
		if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
			const type = node.type;
			const isConst =
				ts.isTypeReferenceNode(type) &&
				ts.isIdentifier(type.typeName) &&
				type.typeName.text === "const";
			if (!isConst) report(node, `type assertion to ${type.getText(source)}`);
		}
		if (ts.isNonNullExpression(node)) report(node, "non-null assertion");
		if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, "`any`");
		const name = declaredName(node);
		if (name !== undefined && /^#?_/.test(name.text)) {
			report(name, `identifier ${name.text}`);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

describe("rover > source rules", () => {
	it("src has no type assertion, non-null assertion, `any` or leading underscore", () => {
		expect(sourceFiles(srcDir).flatMap(violations)).toEqual([]);
	});

	it("catches each of them", () => {
		const probe = join(import.meta.dirname, "../__helpers__/rule-probe.ts.txt");
		const lines = violations(probe).map((line) => line.replace(/^\S+ /, ""));
		expect(lines).toEqual([
			"type assertion to string",
			"non-null assertion",
			"`any`",
			"identifier _unused",
			"identifier #_hidden",
		]);
	});
});
