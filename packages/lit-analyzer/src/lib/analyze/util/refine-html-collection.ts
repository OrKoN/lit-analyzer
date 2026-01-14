import { toSimpleType } from "ts-simple-type";
import { SymbolFlags, TypeChecker, SourceFile, displayPartsToString, Symbol, Node } from "typescript";
import { HtmlDataCollection, HtmlTag, HtmlProp, HtmlAttr } from "../parse/parse-html-data/html-tag.js";
import { lazy } from "../util/general-util.js";

interface ExtendedTypeChecker extends TypeChecker {
	resolveName(name: string, location: Node | undefined, meaning: SymbolFlags, excludeGlobals: boolean): Symbol | undefined;
}

/**
 * Refines the types of the HTML tags in the collection by looking up the tag name in the
 * HTMLElementTagNameMap interface. This allows resolving generic types that are instanced
 * in the map (e.g. "my-generic": GenericElement<{ foo: string }>).
 */
export function refineHtmlCollectionWithTagNameMap(collection: HtmlDataCollection, checker: TypeChecker, sourceFile: SourceFile): void {
	// Try to find the HTMLElementTagNameMap symbol
	// Try to find the HTMLElementTagNameMap symbol
	const mapSymbol = (checker as unknown as ExtendedTypeChecker).resolveName("HTMLElementTagNameMap", sourceFile, SymbolFlags.Interface, false);
	if (!mapSymbol) {
		return;
	}

	// Get the type of the map (this includes merged declarations)
	const mapType = checker.getDeclaredTypeOfSymbol(mapSymbol);

	// properties of the map are the tag names
	const mapProperties = checker.getPropertiesOfType(mapType);

	for (const prop of mapProperties) {
		const tagName = prop.getName();

		// Find if we have a tag for this name in our collection
		let tag: HtmlTag | undefined = collection.tags.find(t => t.tagName === tagName);

		// Get the specific type of this element from the map property.
		// We use the property's value declaration to get the type.
		// If there are multiple declarations, one of them should suffice as the interface is merged,
		// but specifically for the property type, we want the type of the member.
		const declaration = prop.valueDeclaration || (prop.declarations && prop.declarations[0]);
		if (!declaration) continue;

		const elementType = checker.getTypeOfSymbolAtLocation(prop, declaration);

		if (!tag) {
			// If the tag is not found, we create it from the type in the map.
			// This handles cases where the element is only declared in the map but not defined in code (or WCA failed to find it).
			tag = {
				tagName,
				attributes: [],
				properties: [],
				events: [],
				slots: [],
				cssParts: [],
				cssProperties: [],
				builtIn: false
			};
			collection.tags.push(tag);

			// Populate properties from the type
			const elementProperties = checker.getPropertiesOfType(elementType);
			for (const symbol of elementProperties) {
				const symbolDecl = symbol.valueDeclaration || (symbol.declarations && symbol.declarations[0]);

				// Skip if declaration is in default lib (e.g. HTMLElement properties) to avoid duplications/noise
				// We assume global/built-in tags cover these.
				if (symbolDecl) {
					const fileName = symbolDecl.getSourceFile().fileName;
					if (fileName.includes("lib.dom.d.ts") || fileName.includes("lib.es5.d.ts")) {
						continue;
					}

					// Also skip methods as they are usually not properties we bind to
					const type = checker.getTypeOfSymbolAtLocation(symbol, symbolDecl);
					if (type.getCallSignatures().length > 0) {
						continue;
					}

					const htmlProp: HtmlProp = {
						kind: "property",
						name: symbol.getName(),
						description: displayPartsToString(symbol.getDocumentationComment(checker)),
						getType: lazy(() => {
							return toSimpleType(type, checker);
						})
					};
					tag.properties.push(htmlProp);

					// Also add as attribute?
					// For now, we assume properties might be attributes if they are simple types?
					// Or just add them as attributes to be safe for "unknown-attribute" checks?
					// WCA usually adds attributes if they seem like attributes.
					// Let's add it as an attribute if it's not a symbol that clearly looks like a private member or something.
					tag.attributes.push({
						kind: "attribute",
						name: symbol.getName(), // Assume attribute name matches property name for simplicity
						description: htmlProp.description,
						getType: htmlProp.getType
					} as HtmlAttr);
				}
			}
		}

		// Now we want to update the properties of 'tag' to use 'elementType' for type resolution.
		tag.properties.forEach(htmlProp => {
			// Find the property in the elementType
			const elementPropSymbol = checker.getPropertyOfType(elementType, htmlProp.name);

			if (elementPropSymbol) {
				// We found the property on the instantiated element type.
				// We need to capture the *instantiated* type of this property.

				// We create a new lazy getType function that resolves the type from the instantiated element.
				htmlProp.getType = () => {
					// We need a location to resolve the type. Using the declaration of the property itself is usually best.
					// However, getTypeOfSymbolAtLocation requires a node.
					const propDecl = elementPropSymbol.valueDeclaration || (elementPropSymbol.declarations && elementPropSymbol.declarations[0]);

					if (!propDecl) {
						// Fallback if no declaration (e.g. synthetic), though unlikely for class members.
						return toSimpleType(checker.getTypeOfSymbolAtLocation(elementPropSymbol, declaration), checker);
					}

					return toSimpleType(checker.getTypeOfSymbolAtLocation(elementPropSymbol, propDecl), checker);
				};
			}
		});
	}
}
