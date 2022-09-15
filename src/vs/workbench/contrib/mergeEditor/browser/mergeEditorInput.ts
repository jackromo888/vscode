/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assertFn } from 'vs/base/common/assert';
import { autorun } from 'vs/base/common/observable';
import { isEqual } from 'vs/base/common/resources';
import { isDefined } from 'vs/base/common/types';
import { URI } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { IFileService } from 'vs/platform/files/common/files';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILabelService } from 'vs/platform/label/common/label';
import { DEFAULT_EDITOR_ASSOCIATION, EditorInputCapabilities, IResourceMergeEditorInput, IRevertOptions, isResourceMergeEditorInput, IUntypedEditorInput } from 'vs/workbench/common/editor';
import { EditorInput, IEditorCloseHandler } from 'vs/workbench/common/editor/editorInput';
import { AbstractTextResourceEditorInput } from 'vs/workbench/common/editor/textResourceEditorInput';
import { IMergeEditorInputModel, TempFileMergeEditorModeFactory } from 'vs/workbench/contrib/mergeEditor/browser/mergeEditorInputModel';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ILanguageSupport, ITextFileSaveOptions, ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';

export class MergeEditorInputData {
	constructor(
		readonly uri: URI,
		readonly title: string | undefined,
		readonly detail: string | undefined,
		readonly description: string | undefined,
	) { }
}

export class MergeEditorInput extends AbstractTextResourceEditorInput implements ILanguageSupport {

	static readonly ID = 'mergeEditor.Input';

	private _inputModel?: IMergeEditorInputModel;

	override closeHandler: IEditorCloseHandler = {
		showConfirm: () => this._inputModel?.shouldConfirmClose() ?? false,
		confirm: async (editors) => {
			assertFn(() => editors.every(e => e.editor instanceof MergeEditorInput));
			const inputModels = editors.map(e => (e.editor as MergeEditorInput)._inputModel).filter(isDefined);
			return await this._inputModel!.confirmClose(inputModels);
		},
	};

	constructor(
		public readonly base: URI,
		public readonly input1: MergeEditorInputData,
		public readonly input2: MergeEditorInputData,
		public readonly result: URI,
		@IInstantiationService private readonly _instaService: IInstantiationService,
		@IEditorService editorService: IEditorService,
		@ITextFileService textFileService: ITextFileService,
		@ILabelService labelService: ILabelService,
		@IFileService fileService: IFileService,
	) {
		super(result, undefined, editorService, textFileService, labelService, fileService);

		/*
		const that = this;

		this._register(
			_workingCopyEditorService.registerHandler({
				createEditor(workingCopy) {
					throw new BugIndicatingError('not supported');
				},
				handles(workingCopy) {
					return workingCopy.typeId === '' && workingCopy.resource.toString() === that._model?.resultTextModel.uri.toString();
				},
				isOpen(workingCopy, editor) {
					return workingCopy.resource.toString() === that._model?.resultTextModel.uri.toString();
				},
			})
		);*/
	}

	override dispose(): void {
		super.dispose();
	}

	get typeId(): string {
		return MergeEditorInput.ID;
	}

	override get editorId(): string {
		return DEFAULT_EDITOR_ASSOCIATION.id;
	}

	override get capabilities(): EditorInputCapabilities {
		return super.capabilities | EditorInputCapabilities.MultipleEditors | EditorInputCapabilities.Untitled;
	}

	override getName(): string {
		return localize('name', "Merging: {0}", super.getName());
	}

	private readonly mergeEditorModeFactory = this._instaService.createInstance(TempFileMergeEditorModeFactory);

	override async resolve(): Promise<IMergeEditorInputModel> {
		if (!this._inputModel) {
			const inputModel = this._register(await this.mergeEditorModeFactory.createInputModel({
				base: this.base,
				input1: this.input1,
				input2: this.input2,
				result: this.result,
			}));
			this._inputModel = inputModel;

			// TODO implement "react" helper
			let first = true;
			this._register(autorun('fire dirty event', (reader) => {
				inputModel.isDirty.read(reader);
				if (first) {
					first = false;
				} else {
					this._onDidChangeDirty.fire();
				}
			}));

			await this._inputModel.model.onInitialized;
		}

		return this._inputModel;
	}

	public async accept(): Promise<void> {
		/*this._temporaryResultModelAlternativeVersionId = this._inputModel!.resultTextModel.getAlternativeVersionId();
		this.updateIsDirty();

		this._outTextModel!.textEditorModel!.setValue(await this._inputModel!.getResultValueWithConflictMarkers());
		await this._outTextModel!.save();*/

		await this._inputModel?.accept();
	}

	override async save(group: number, options?: ITextFileSaveOptions | undefined): Promise<IUntypedEditorInput | undefined> {
		/*this._temporaryResultModelAlternativeVersionId = this._model!.resultTextModel.getAlternativeVersionId();
		this.updateIsDirty();
		this._outTextModel!.textEditorModel!.setValue(this._model!.getResultValueWithConflictMarkers());
		this._outTextModel!.save();*/

		await (await this.resolve()).save();
		return undefined;
	}

	override toUntyped(): IResourceMergeEditorInput {
		return {
			input1: { resource: this.input1.uri, label: this.input1.title, description: this.input1.description, detail: this.input1.detail },
			input2: { resource: this.input2.uri, label: this.input2.title, description: this.input2.description, detail: this.input2.detail },
			base: { resource: this.base },
			result: { resource: this.result },
			options: {
				override: this.typeId
			}
		};
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (this === otherInput) {
			return true;
		}
		if (otherInput instanceof MergeEditorInput) {
			return isEqual(this.base, otherInput.base)
				&& isEqual(this.input1.uri, otherInput.input1.uri)
				&& isEqual(this.input2.uri, otherInput.input2.uri)
				&& isEqual(this.result, otherInput.result);
		}
		if (isResourceMergeEditorInput(otherInput)) {
			return (this.editorId === otherInput.options?.override || otherInput.options?.override === undefined)
				&& isEqual(this.base, otherInput.base.resource)
				&& isEqual(this.input1.uri, otherInput.input1.resource)
				&& isEqual(this.input2.uri, otherInput.input2.resource)
				&& isEqual(this.result, otherInput.result.resource);
		}

		return false;
	}

	override async revert(group: number, options?: IRevertOptions | undefined): Promise<void> {
		await (await this.resolve()).revert();
		return undefined;
	}

	// ---- FileEditorInput

	override isDirty(): boolean {
		return this._inputModel?.isDirty.get() ?? false;
	}

	setLanguageId(languageId: string, source?: string): void {
		this._inputModel?.model.setLanguageId(languageId, source);
	}

	// implement get/set languageId
	// implement get/set encoding
}


// class MergeEditorCloseHandler implements IEditorCloseHandler {
// 	constructor(
// 		private readonly _model: MergeEditorModel,
// 		readonly input: MergeEditorInput,
// 		@IDialogService private readonly _dialogService: IDialogService,
// 	) { }

// 	showConfirm(): boolean {
// 		return this.input.isDirty() && this._model.hasUnhandledConflicts.get();
// 	}

// 	async confirm(editors: readonly IEditorIdentifier[]): Promise<ConfirmResult> {
// 		const mergeInputs = editors.map(e => e.editor as MergeEditorInput);

// 		assert(mergeInputs.length >= 1);

// 		const handler: MergeEditorCloseHandler[] = [];
// 		let someAreDirty = false;

// 		for (const { editor } of editors) {
// 			if (editor.closeHandler instanceof MergeEditorCloseHandler && editor.closeHandler._model.hasUnhandledConflicts.get()) {
// 				handler.push(editor.closeHandler);
// 				someAreDirty = someAreDirty || editor.isDirty();
// 			}
// 		}

// 		if (handler.length === 0) {
// 			// shouldn't happen
// 			return ConfirmResult.SAVE;
// 		}

// 		const result = someAreDirty
// 			? await this._confirmDirty(handler)
// 			: await this._confirmNoneDirty(handler);

// 		if (result !== ConfirmResult.CANCEL) {
// 			// save or ignore: in both cases we tell the inputs to ignore unhandled conflicts
// 			// for the dirty state computation.

// 			if (result === ConfirmResult.SAVE) {
// 				// save: we tell the inputs to write their contents to the result file
// 				for (const h of handler) {
// 					h.input.accept();
// 				}
// 			}
// 		}

// 		return result;
// 	}

// 	private async _confirmDirty(handler: MergeEditorCloseHandler[]): Promise<ConfirmResult> {
// 		const isMany = handler.length > 1;

// 		const message = isMany
// 			? localize('messageN', 'Do you want to save the changes you made to {0} files?', handler.length)
// 			: localize('message1', 'Do you want to save the changes you made to {0}?', basename(handler[0]._model.resultTextModel.uri));

// 		const options = {
// 			cancelId: 2,
// 			detail: isMany
// 				? localize('detailN', "The files contain unhandled conflicts. Your changes will be lost if you don't save them.")
// 				: localize('detail1', "The file contains unhandled conflicts. Your changes will be lost if you don't save them.")
// 		};

// 		const actions: string[] = [
// 			localize('saveWithConflict', "Save with Conflicts"),
// 			localize('discard', "Don't Save"),
// 			localize('cancel', "Cancel"),
// 		];

// 		const { choice } = await this._dialogService.show(Severity.Info, message, actions, options);

// 		if (choice === options.cancelId) {
// 			// cancel: stay in editor
// 			return ConfirmResult.CANCEL;
// 		} else if (choice === 0) {
// 			// save with conflicts
// 			return ConfirmResult.SAVE;
// 		} else {
// 			// discard changes
// 			return ConfirmResult.DONT_SAVE;
// 		}
// 	}

// 	private async _confirmNoneDirty(handler: MergeEditorCloseHandler[]): Promise<ConfirmResult> {
// 		const isMany = handler.length > 1;

// 		const message = isMany
// 			? localize('conflictN', 'Do you want to close with conflicts in {0} files?', handler.length)
// 			: localize('conflict1', 'Do you want to close with conflicts in {0}?', basename(handler[0]._model.resultTextModel.uri));

// 		const options = {
// 			cancelId: 1,
// 			detail: isMany
// 				? localize('detailNotDirtyN', "The files contain unhandled conflicts.")
// 				: localize('detailNotDirty1', "The file contains unhandled conflicts.")
// 		};

// 		const actions = [
// 			localize('closeWithConflicts', "Close with Conflicts"),
// 			localize('cancel', "Cancel"),
// 		];

// 		const { choice } = await this._dialogService.show(Severity.Info, message, actions, options);
// 		if (choice === options.cancelId) {
// 			return ConfirmResult.CANCEL;
// 		} else {
// 			return ConfirmResult.DONT_SAVE;
// 		}
// 	}
// }
