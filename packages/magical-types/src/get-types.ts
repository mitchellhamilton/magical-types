import typescript from "typescript";
import { NodePath, types } from "@babel/core";
import * as BabelTypes from "@babel/types";
import { MagicalNode, Property, TypeParameterNode } from "./types";
import { InternalError } from "./errors";
import { Project } from "ts-morph";
import * as flatted from "flatted";

export function getTypes(
  filename: string,
  things: Map<
    number,
    Map<
      number,
      {
        exportName: "PropTypes" | "FunctionTypes" | "RawTypes";
        path: NodePath<BabelTypes.JSXOpeningElement>;
      }
    >
  >,
  numOfThings: number
) {
  let configFileName = typescript.findConfigFile(
    filename,
    typescript.sys.fileExists
  );
  if (!configFileName) {
    throw new Error("No tsconfig.json file could be found");
  }
  const project = new Project({
    tsConfigFilePath: configFileName,
    addFilesFromTsConfig: false
  });
  project.addExistingSourceFile(filename);
  project.resolveSourceFileDependencies();
  function getFunctionComponentProps(type: typescript.Type) {
    const callSignatures = type.getCallSignatures();

    if (callSignatures.length) {
      for (const sig of callSignatures) {
        const params = sig.getParameters();
        if (params.length !== 0) {
          return params[0];
        }
      }
    }
  }

  let wrapInCache = <Arg, Return>(
    arg: (type: Arg, path: Array<string | number>) => Return
  ) => {
    let cache = new Map<Arg, Return>();
    return (type: Arg, path: Array<string | number>): Return => {
      let cachedNode = cache.get(type);
      if (cachedNode !== undefined) {
        return cachedNode;
      }
      let obj = {} as Return;
      cache.set(type, obj);
      try {
        let node = arg(type, path);
        Object.assign(obj, node);
        return obj;
      } catch (err) {
        debugger;
        if (
          !err.message.startsWith(
            "The following error occurred while trying to stringify"
          )
        ) {
          err.message = `The following error occurred while trying to stringify the following path: ${path} :${
            err.message
          }`;
        }
        throw err;
      }
    };
  };

  let convertParameter = wrapInCache((parameter: typescript.Symbol, path) => {
    let declaration = parameter.valueDeclaration || parameter.declarations[0];
    if (!typescript.isParameter(declaration)) {
      throw new InternalError(
        "expected node to be a parameter declaration but it was not"
      );
    }

    if (typeChecker.isOptionalParameter(declaration) && declaration.type) {
      return {
        required: false,
        name: parameter.name,
        type: convertType(
          typeChecker.getTypeFromTypeNode(declaration.type),
          path.concat("getParameters()", parameter.name)
        )
      };
    }

    let type = typeChecker.getTypeOfSymbolAtLocation(parameter, declaration);
    return {
      required: true,
      name: parameter.name,
      type: convertType(type, path.concat("getParameters()", parameter.name))
    };
  });

  let convertSignature = wrapInCache(
    (callSignature: typescript.Signature, path: Array<string | number>) => {
      let returnType = callSignature.getReturnType();
      let typeParameters = callSignature.getTypeParameters() || [];
      let parameters = callSignature
        .getParameters()
        .map(param => convertParameter(param, path));

      return {
        type: "Signature",
        return: convertType(returnType, path.concat("getReturnType()")),
        parameters,
        typeParameters: typeParameters.map(
          (x, index) =>
            convertType(
              x,
              path.concat("typeParameters", index)
            ) as TypeParameterNode
        )
      } as const;
    }
  );

  function getClassComponentProps(type: typescript.Type) {
    const constructSignatures = type.getConstructSignatures();

    if (constructSignatures.length) {
      for (const sig of constructSignatures) {
        const instanceType = sig.getReturnType();
        const props = instanceType.getProperty("props");
        if (props) {
          return props;
        }
      }
    }
  }

  function convertProperty(
    symbol: typescript.Symbol,
    path: Array<string | number>
  ): Property {
    let declaration = symbol.valueDeclaration || symbol.declarations[0];

    if (!declaration) {
      debugger;
    }
    let isRequired = !(symbol.flags & typescript.SymbolFlags.Optional);
    let type = typeChecker.getTypeOfSymbolAtLocation(symbol, declaration);
    // TODO: this could be better
    let key = symbol.getName();

    let value = convertType(type, path.concat("getProperties()", key));

    // i know this is technically wrong but this is better than every optional thing
    // being a union of undefined and the type
    // ideally, we would have the type of the property without undefined unless it's actually a union of undefined and the type
    if (!isRequired && value.type === "Union") {
      value.types = value.types.filter(
        x => !(x.type === "Intrinsic" && x.value === "undefined")
      );

      if (
        value.types.length === 2 &&
        value.types.every(
          x =>
            x.type === "Intrinsic" &&
            (x.value === "true" || x.value === "false")
        )
      ) {
        value = {
          type: "Intrinsic",
          value: "boolean"
        };
      } else if (value.types.length === 1) {
        value = value.types[0];
      }
    }

    let thing = typescript.displayPartsToString(
      symbol.getDocumentationComment(typeChecker)
    );
    return {
      description: thing,
      required: isRequired,
      key,
      value: value
    };
  }

  function getNameForType(type: typescript.Type): string | null {
    if (type.symbol) {
      let name = type.symbol.getName();
      if (name !== "__type") {
        return name;
      }
    }
    if (type.aliasSymbol) {
      return type.aliasSymbol.getName();
    }
    return null;
  }

  function typeFlagsToString(type: typescript.Type) {
    return Object.keys(typescript.TypeFlags).filter(
      // @ts-ignore
      flagName => type.flags & typescript.TypeFlags[flagName]
    );
  }

  let convertType = wrapInCache(
    (type: typescript.Type, path: Array<string | number>): MagicalNode => {
      if (!type) {
        throw new InternalError(`falsy type at path: ${path}`);
      }
      if (
        (type as any).intrinsicName &&
        (type as any).intrinsicName !== "error"
      ) {
        return {
          type: "Intrinsic",
          value: (type as any).intrinsicName
        };
      }

      // i think this is done badly
      if (type.symbol && type.symbol.escapedName === "Promise") {
        return {
          type: "Promise",
          value: convertType(
            (type as any).typeArguments[0],
            path.concat("typeArguments", 0)
          )
        };
      }

      if (type.isStringLiteral()) {
        return {
          type: "StringLiteral",
          value: type.value
        };
      }
      if (type.isNumberLiteral()) {
        return {
          type: "NumberLiteral",
          value: type.value
        };
      }
      if (type.isUnion()) {
        let types = type.types.map((type, index) =>
          convertType(type, path.concat("types", index))
        );
        if (
          types.filter(
            x =>
              x.type === "Intrinsic" &&
              (x.value === "false" || x.value === "true")
          ).length === 2
        ) {
          let allTypes = types;
          types = [];
          let needsToAddBoolean = true;
          for (let type of allTypes) {
            if (
              type.type === "Intrinsic" &&
              (type.value === "true" || type.value === "false")
            ) {
              if (needsToAddBoolean) {
                needsToAddBoolean = false;
                types.push({ type: "Intrinsic", value: "boolean" });
              }
            } else {
              types.push(type);
            }
          }
        }

        return {
          type: "Union",
          name: getNameForType(type),
          types
        };
      }
      if (type.isIntersection()) {
        return {
          type: "Intersection",
          types: type.types.map((type, index) =>
            convertType(type, path.concat("types", index))
          )
        };
      }

      if ((typeChecker as any).isArrayType(type)) {
        // TODO: fix ReadonlyArray
        return {
          type: "Array",
          value: convertType(
            (type as any).typeArguments[0],
            path.concat("typeArguments", 0)
          )
        };
      }

      if ((typeChecker as any).isTupleType(type)) {
        return {
          type: "Tuple",
          value: ((type as any) as {
            typeArguments: Array<typescript.Type>;
          }).typeArguments.map((x, index) =>
            convertType(x, path.concat("typeArguments", index))
          )
        };
      }

      if (type.isClass()) {
        return {
          type: "Class",
          name: type.symbol ? type.symbol.getName() : null,
          typeParameters: (type.typeParameters || []).map((x, index) =>
            convertType(x, path.concat("typeParameters", index))
          ),
          thisNode: type.thisType
            ? convertType(type.thisType, path.concat("thisType"))
            : null,
          properties: type.getProperties().map((symbol, index) => {
            return convertProperty(symbol, path);
          })
        };
      }

      if (type.flags & typescript.TypeFlags.Object) {
        return {
          type: "Object",
          name: getNameForType(type),
          aliasTypeArguments: (type.aliasTypeArguments || []).map(
            (type, index) => {
              return convertType(
                type,
                path.concat("aliasTypeArguments", index)
              );
            }
          ),
          constructSignatures: type
            .getConstructSignatures()
            .map((constructSignature, index) =>
              convertSignature(
                (constructSignature as any).target
                  ? ((constructSignature as any) as {
                      target: typescript.Signature;
                    }).target
                  : constructSignature,
                path.concat("getConstructSignatures()", index)
              )
            ),
          callSignatures: type
            .getCallSignatures()
            .map((callSignature, index) =>
              convertSignature(
                (callSignature as any).target
                  ? ((callSignature as any) as { target: typescript.Signature })
                      .target
                  : callSignature,
                path.concat("getCallSignatures()", index)
              )
            ),
          properties: type.getProperties().map((symbol, index) => {
            return convertProperty(symbol, path);
          })
        };
      }
      if (type.isTypeParameter()) {
        return {
          type: "TypeParameter",
          value: type.symbol.getName()
        };
      }
      // @ts-ignore
      if (type.flags & typescript.TypeFlags.IndexedAccess) {
        let indexedAccessType = type as typescript.IndexedAccessType;

        return {
          type: "IndexedAccess",
          object: convertType(
            indexedAccessType.objectType,
            path.concat("object")
          ),
          index: convertType(indexedAccessType.indexType, path.concat("index"))
        };
      }
      // @ts-ignore
      if (type.flags & typescript.TypeFlags.Conditional) {
        let conditionalType = type as typescript.ConditionalType;
        return {
          type: "Conditional",
          check: convertType(
            conditionalType.checkType,
            path.concat("checkType")
          ),
          extends: convertType(
            conditionalType.extendsType,
            path.concat("extendsType")
          ),
          false: convertType(
            (conditionalType as any).root.falseType,
            path.concat("falseType")
          ),
          true: convertType(
            (conditionalType as any).root.trueType,
            path.concat("trueType")
          )
        };
      }
      let flags = typeFlagsToString(type);
      debugger;

      throw new InternalError(
        `Could not stringify type with flags: ${JSON.stringify(
          flags,
          null,
          2
        )} and path: ${path}`
      );
    }
  );

  let sourceFile = project.getSourceFileOrThrow(filename).compilerNode;
  let typeChecker = project.getTypeChecker().compilerObject;

  let num = 0;
  let visit = (node: typescript.Node) => {
    typescript.forEachChild(node, node => {
      let map = things.get(node.pos);

      if (map) {
        let val = map.get(node.end);
        if (val) {
          let { exportName, path } = val;
          num++;
          if (!typescript.isJsxOpeningLikeElement(node.parent)) {
            throw new InternalError("is not a jsx opening element");
          }
          let jsxOpening = node.parent;
          let type: typescript.Type;
          if (exportName === "PropTypes" || exportName === "FunctionTypes") {
            let componentAttrib = jsxOpening.attributes.properties.find(
              x =>
                typescript.isJsxAttribute(x) &&
                x.name.escapedText ===
                  (exportName === "PropTypes" ? "component" : "function")
            );
            if (
              !(
                componentAttrib &&
                typescript.isJsxAttribute(componentAttrib) &&
                componentAttrib.initializer &&
                typescript.isJsxExpression(componentAttrib.initializer) &&
                componentAttrib.initializer.expression
              )
            ) {
              throw new InternalError("could not find component attrib");
            }
            let nodeForType = componentAttrib.initializer.expression;

            let symbol = typeChecker.getSymbolAtLocation(nodeForType);

            if (!symbol) {
              throw new InternalError("could not find symbol");
            }
            type = typeChecker.getTypeOfSymbolAtLocation(
              symbol,
              symbol.valueDeclaration || symbol.declarations![0]
            );

            if (exportName === "PropTypes") {
              let propsSymbol =
                getFunctionComponentProps(type) || getClassComponentProps(type);

              if (!propsSymbol) {
                throw new InternalError("could not find props symbol");
              }

              type = typeChecker.getTypeOfSymbolAtLocation(
                propsSymbol,
                propsSymbol.valueDeclaration || propsSymbol.declarations![0]
              );
            }
          } else {
            if (!jsxOpening.typeArguments) {
              throw new InternalError("no type arguments on RawTypes");
            }
            if (!jsxOpening.typeArguments[0]) {
              throw new InternalError("no type argument on RawTypes");
            }
            type = typeChecker.getTypeFromTypeNode(jsxOpening.typeArguments[0]);
          }
          let converted = convertType(type, []);
          debugger;
          path.node.attributes.push(
            BabelTypes.jsxAttribute(
              BabelTypes.jsxIdentifier("__types"),
              BabelTypes.jsxExpressionContainer(
                BabelTypes.stringLiteral(flatted.stringify(converted))
              )
            )
          );
        }
      }

      visit(node);
    });
  };
  visit(sourceFile);
  if (num !== numOfThings) {
    throw new InternalError("num !== numOfThings");
  }
}
