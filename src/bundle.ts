import * as postcss from 'postcss';

import { Pojo } from "./types";
import { removeUnusedRules } from "./stylable-utils";
import { StylableMeta, SDecl, Imported } from "./stylable-processor";
import { StylableResults } from "./stylable-transformer";
import { StylableResolver } from "./postcss-resolver";
import { valueReplacer } from "./value-template";

export type OverrideVars = Pojo<string>;
export type OverrideDef = { overrideRoot: StylableMeta, overrideVars: OverrideVars };
export interface ThemeOverrideData {
    index: number;
    path: string;
    overrideDefs: OverrideDef[];
}
export type ThemeEntries = Pojo<ThemeOverrideData>; // ToDo: change name to indicate path
export type Process = (entry: string) => StylableResults;
export type Transform = (meta: StylableMeta) => StylableMeta;

export function bundle(usedFiles:string[], resolver:StylableResolver, process:Process, transform:Transform):{css:string} {
    const bundler = new Bundler(resolver, process, transform);

    usedFiles.forEach(path => bundler.addUsedFile(path));

    return {
        css: bundler.generateCSS()
    };
}
export class Bundler {
    private themeAcc: ThemeEntries = {};
    private outputCSS: string[] = [];
    constructor(
        private resolver:StylableResolver, 
        private process:Process,
        private transform:Transform
    ){}

    public addUsedFile(path:string):void {
        const entryIndex = this.outputCSS.length;
        const { meta:entryMeta } = this.process(path);
        this.aggregateTheme(entryMeta, entryIndex, this.themeAcc);
        this.outputCSS.push(entryMeta.source);
    }

    private aggregateTheme(entryMeta:StylableMeta, entryIndex:number, themeEntries:ThemeEntries):void {
        const aggregateDependencies = (srcMeta:StylableMeta, overrideVars:OverrideVars) => {
            srcMeta.imports.forEach(importRequest => {
                if(!importRequest.from.match(/.css$/)){
                    return;
                }       

                const isImportTheme = !!importRequest.theme;
                let themeOverrideData = themeEntries[importRequest.from]; // some entry already imported as theme

                const { meta: importMeta } = this.process(importRequest.from);
                let themeOverrideVars;

                if(isImportTheme){ // collect and search sub-themes
                    // if (usedFiles.indexOf(_import.from) !== -1) { // theme cannot be used in JS - can we fix this?
                    //     throw new Error('theme should not be imported from JS')
                    // }
                    themeOverrideData = themeEntries[importRequest.from] = themeOverrideData || { index:entryIndex, path: importMeta.source, overrideDefs: []};
                    themeOverrideVars = generateThemeOverrideVars(srcMeta, importRequest, overrideVars);

                    if(themeOverrideVars){
                        themeOverrideData.overrideDefs.unshift({ overrideRoot:entryMeta, overrideVars: themeOverrideVars });
                    }
                }
                if(themeOverrideData){ // push theme above import
                    themeOverrideData.index = entryIndex;
                }
                aggregateDependencies(importMeta, themeOverrideVars || {});
            });
        }

        aggregateDependencies(entryMeta, {});
    }

    public getDependencyPaths({entries, themeEntries}:{entries:string[], themeEntries:ThemeEntries}={entries:this.outputCSS, themeEntries:this.themeAcc}):string[] {
        const results = entries.concat();
        const themePaths = Object.keys(themeEntries);
        themePaths.reverse().forEach(themePath => {
            const { index, path } = themeEntries[themePath];
            results.splice(index + 1, 0, path);
        });
        return results;
    }

    public getUsedFilePaths():string[] {
        return this.getDependencyPaths({entries:this.outputCSS, themeEntries:{}});
    }

    public generateCSS(usedSheetPaths?:string[]):string {
        // collect stylesheet meta list
        let outputMetaList:StylableMeta[];
        if(!usedSheetPaths){
            usedSheetPaths = this.getDependencyPaths({entries:this.outputCSS, themeEntries:{/*no theme entries*/}});
            outputMetaList = this.getDependencyPaths().map(path => this.process(path).meta);
        } else {
            const themeEntries:ThemeEntries = {};
            usedSheetPaths.forEach((path, index) => this.aggregateTheme(this.process(path).meta, index, themeEntries));
            outputMetaList = this.getDependencyPaths({entries:usedSheetPaths, themeEntries}).map(path => this.process(path).meta);
        }

        // index each output entry position
        const pathToIndex = outputMetaList.reduce<Pojo<number>>((acc, meta, index) => {
            acc[meta.source] = index;
            return acc;
        }, {})

        // clean unused and add overrides
        outputMetaList = outputMetaList.map(entryMeta => {
            entryMeta = this.transform({...entryMeta, ast:entryMeta.ast.clone()});
            this.cleanUnused(entryMeta, usedSheetPaths!);
            this.applyOverrides(entryMeta, pathToIndex);
            return entryMeta;
        });         

        // emit output CSS
        return outputMetaList.reverse()
                .map(meta => meta.ast.toString())
                .filter(entryCSS => !!entryCSS)
                .join('\n');
    }

    private cleanUnused(meta:StylableMeta, usedPaths:string[]):void {
        meta.imports.forEach(importRequest => removeUnusedRules(meta, importRequest, usedPaths));
    }
    // resolveFrom(_import){
    //     return {
    //         ..._import
    //         from: this.resolvePath(_import.from)
    //     }
    // }
    private applyOverrides(entryMeta:StylableMeta, pathToIndex:Pojo<number>):void {
        const outputAST = entryMeta.ast;
        const outputRootSelector = getSheetNSRootSelector(entryMeta);

        // get overrides from each overridden stylesheet 
        const overrideInstructions = Object.keys(entryMeta.mappedSymbols).reduce<{ overrideDefs:OverrideDef[], overrideVarsPerDef:Pojo<OverrideVars> }>((acc, symbolId) => {
            const symbol = entryMeta.mappedSymbols[symbolId];
            const isLocalVar = (symbol._kind === 'var');
            const resolve = this.resolver.deepResolve(symbol);
            const varSourceId = isLocalVar ? symbolId : resolve && resolve.symbol.name
            //ToDo: check resolve._kind === 'css'
            const originMeta = isLocalVar ? entryMeta : resolve && resolve.meta; // ToDo: filter just vars and imported vars
            if(originMeta) {
                const overridePath = originMeta.source;
                const themeEntry = this.themeAcc[overridePath];
                if(themeEntry){
                    themeEntry.overrideDefs.forEach(overrideDef => { // ToDo: check import as
                        if(overrideDef.overrideVars[varSourceId]){
                            const overridePath = overrideDef.overrideRoot.source;
                            const overrideIndex = pathToIndex[overridePath];
                            if(!acc.overrideVarsPerDef[overridePath]){
                                acc.overrideVarsPerDef[overridePath] = { [symbolId]: overrideDef.overrideVars[varSourceId] };
                            } else {
                                acc.overrideVarsPerDef[overridePath][symbolId] = overrideDef.overrideVars[varSourceId];
                            }
                            acc.overrideDefs[overrideIndex] = overrideDef;
                        }
                    });
                }
            }
            return acc;
        }, { overrideDefs:[], overrideVarsPerDef:{} });

        // sort override instructions according to insertion order
        const sortedOverrides:{ rootSelector:string, overrideVars:OverrideVars }[] = [];
        for(let i = 0; i < overrideInstructions.overrideDefs.length; ++i) {
            const overrideDef = overrideInstructions.overrideDefs[i];
            if(overrideDef){
                const rootSelector = getSheetNSRootSelector(overrideDef.overrideRoot);
                const overrideVars = overrideInstructions.overrideVarsPerDef[overrideDef.overrideRoot.source];
                sortedOverrides.push({ rootSelector , overrideVars });
            }
        }

        // generate override rulesets
        const overrideRulesets:{ruleOverride:postcss.Rule, srcRule:postcss.Rule}[] = [];
        outputAST.walkRules(srcRule => {
            sortedOverrides.forEach(({rootSelector, overrideVars}) => {
                let overrideSelector = srcRule.selector;
                if(rootSelector !== outputRootSelector) {
                    overrideSelector = overrideSelector.replace(new RegExp(outputRootSelector), rootSelector); // scope override
                    overrideSelector = (overrideSelector === srcRule.selector) ? '.' + rootSelector + ' ' + overrideSelector : overrideSelector; // scope globals
                }
                let ruleOverride = postcss.rule({selector:overrideSelector});
                srcRule.walkDecls((decl: SDecl) => {
                    const overriddenValue = valueReplacer(decl.sourceValue, overrideVars, (value) => {
                        return value;
                    });
                    if (decl.value !== overriddenValue) {
                        ruleOverride.append(postcss.decl({prop:decl.prop, value:overriddenValue}));
                    }
                });
                if(ruleOverride.nodes && ruleOverride.nodes.length){
                    overrideRulesets.push({ruleOverride, srcRule});
                }
            });
        });
        
        overrideRulesets.reverse().forEach(({ruleOverride, srcRule}) => {
            outputAST.insertAfter(srcRule, ruleOverride);
        });
    }
}

function getSheetNSRootSelector(meta:StylableMeta):string {
    return meta.namespace + '--' + meta.root;
}

function generateThemeOverrideVars(
    srcMeta:StylableMeta, 
    {overrides:srcImportOverrides, from:themePath}:Imported, 
    overrides:OverrideVars):OverrideVars|null {
    // get override vars from import
    let importOverrides = srcImportOverrides.reduce<OverrideVars>((acc, dec) => {
        acc[dec.prop] = dec.value;
        return acc;
    }, {});
    // add context override
    for(let overrideProp in overrides){
        const symbol = srcMeta.mappedSymbols[overrideProp];
        if(symbol._kind === 'import' && symbol.import.from === themePath && !importOverrides[overrideProp]){
            importOverrides[symbol.name] = overrides[overrideProp];
        }
    }
    return Object.keys(importOverrides).length ? importOverrides : null;
}

//createAllModulesRelations
//expendRelationsToDeepImports
//forEachRelationsExtractOverrides
//forEachRelationsPrintWithOverrides
