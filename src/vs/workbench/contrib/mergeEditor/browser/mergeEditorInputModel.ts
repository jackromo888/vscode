/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assertFn } from 'vs/base/common/assert';
import { BugIndicatingError } from 'vs/base/common/errors';
import { Event } from 'vs/base/common/event';
import { DisposableStore, IDisposable } from 'vs/base/common/lifecycle';
import { derived, IObservable, observableFromEvent, observableValue } from 'vs/base/common/observable';
import { basename, isEqual } from 'vs/base/common/resources';
import Severity from 'vs/base/common/severity';
import { URI } from 'vs/base/common/uri';
import { WorkerBasedDocumentDiffProvider } from 'vs/editor/browser/widget/workerBasedDocumentDiffProvider';
import { IModelService } from 'vs/editor/common/services/model';
import { IResolvedTextEditorModel, ITextModelService } from 'vs/editor/common/services/resolverService';
import { localize } from 'vs/nls';
import { ConfirmResult, IDialogOptions, IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { IEditorModel } from 'vs/platform/editor/common/editor';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { EditorModel } from 'vs/workbench/common/editor/editorModel';
import { MergeEditorInputData } from 'vs/workbench/contrib/mergeEditor/browser/mergeEditorInput';
import { MergeDiffComputer } from 'vs/workbench/contrib/mergeEditor/browser/model/diffComputer';
import { InputData, MergeEditorModel } from 'vs/workbench/contrib/mergeEditor/browser/model/mergeEditorModel';
import { ProjectedDiffComputer } from 'vs/workbench/contrib/mergeEditor/browser/model/projectedDocumentDiffProvider';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { ITextFileEditorModel, ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';

export interface MergeEditorArgs {
	base: URI;
	input1: MergeEditorInputData;
	input2: MergeEditorInputData;
	result: URI;
}

export interface IMergeEditorInputModelFactory {
	createInputModel(args: MergeEditorArgs): Promise<IMergeEditorInputModel>;
}

export interface IMergeEditorInputModel extends IDisposable, IEditorModel {
	readonly resultUri: URI;

	readonly model: MergeEditorModel;
	readonly isDirty: IObservable<boolean>;

	save(): Promise<void>;

	/**
	 * If save resets the dirty state, revert must do so too.
	*/
	revert(): Promise<void>;

	shouldConfirmClose(): boolean;

	confirmClose(inputModels: IMergeEditorInputModel[]): Promise<ConfirmResult>;

	/**
	 * Marks the merge as done. The merge editor must be closed afterwards.
	*/
	accept(): Promise<void>;
}

/* ================ Temp File ================ */

export class TempFileMergeEditorModeFactory implements IMergeEditorInputModelFactory {
	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@IModelService private readonly _modelService: IModelService,
	) {
	}

	async createInputModel(args: MergeEditorArgs): Promise<IMergeEditorInputModel> {
		const store = new DisposableStore();

		const [
			base,
			result,
			input1Data,
			input2Data,
		] = await Promise.all([
			this._textModelService.createModelReference(args.base),
			this._textModelService.createModelReference(args.result),
			toInputData(args.input1, this._textModelService, store),
			toInputData(args.input2, this._textModelService, store),
		]);

		store.add(base);
		store.add(result);


		const tempResultUri = result.object.textEditorModel.uri.with({ scheme: 'merge-result' });

		const temporaryResultModel = this._modelService.createModel(
			'',
			{
				languageId: result.object.textEditorModel.getLanguageId(),
				onDidChange: Event.None,
			},
			tempResultUri,
		);
		store.add(temporaryResultModel);


		/*
		const resultFileProvider = this._instantiationService.createInstance(ResultFileProvider);
		const tempResultUri = await resultFileProvider.getTempResultFileUri(result.object.textEditorModel.uri);
		await this._fileService.createFile(tempResultUri, VSBuffer.fromString(''), { overwrite: true });
		const tempResult = await this._textModelService.createModelReference(tempResultUri);
		store.add(tempResult);
		await tempResult.object.resolve();
		const temporaryResultModel = tempResult.object.textEditorModel;
		*/

		const diffProvider = this._instantiationService.createInstance(WorkerBasedDocumentDiffProvider);
		const model = this._instantiationService.createInstance(
			MergeEditorModel,
			base.object.textEditorModel,
			input1Data,
			input2Data,
			temporaryResultModel,
			this._instantiationService.createInstance(MergeDiffComputer, diffProvider),
			this._instantiationService.createInstance(MergeDiffComputer, this._instantiationService.createInstance(ProjectedDiffComputer, diffProvider))
		);
		store.add(model);

		await model.onInitialized;

		return this._instantiationService.createInstance(TempFileMergeEditorInputModel, model, store, result.object, args.result);
	}
}

class TempFileMergeEditorInputModel extends EditorModel implements IMergeEditorInputModel {
	private readonly savedAltVersionId = observableValue('initialAltVersionId', this.model.resultTextModel.getAlternativeVersionId());
	private readonly altVersionId = observableFromEvent(
		e => this.model.resultTextModel.onDidChangeContent(e),
		() =>
			/** @description getAlternativeVersionId */ this.model.resultTextModel.getAlternativeVersionId()
	);

	public readonly isDirty = derived(
		'isDirty',
		(reader) => this.altVersionId.read(reader) !== this.savedAltVersionId.read(reader)
	);

	private finished = false;

	constructor(
		public readonly model: MergeEditorModel,
		private readonly disposable: IDisposable,
		private readonly result: IResolvedTextEditorModel,
		public readonly resultUri: URI,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
	}

	override dispose(): void {
		this.disposable.dispose();
		super.dispose();
	}

	async accept(): Promise<void> {
		const value = await this.model.getResultValueWithConflictMarkers();
		this.result.textEditorModel.setValue(value);
		this.savedAltVersionId.set(this.model.resultTextModel.getAlternativeVersionId(), undefined);
		await this.textFileService.save(this.result.textEditorModel.uri);
		// TODO delete temp file
		this.finished = true;
	}

	private async _discard(): Promise<void> {
		await this.textFileService.revert(this.model.resultTextModel.uri);
		this.savedAltVersionId.set(this.model.resultTextModel.getAlternativeVersionId(), undefined);
		// TODO delete temp file
		this.finished = true;
	}

	public shouldConfirmClose(): boolean {
		return true;
	}

	public async confirmClose(inputModels: TempFileMergeEditorInputModel[]): Promise<ConfirmResult> {
		assertFn(
			() => inputModels.some((m) => m === this)
		);

		const someDirty = inputModels.some((m) => m.isDirty.get());
		let choice: number;
		if (someDirty) {
			const isMany = inputModels.length > 1;

			const message = isMany
				? localize('messageN', 'Do you want keep the merge result of {0} files?', inputModels.length)
				: localize('message1', 'Do you want keep the merge result of {0}?', basename(inputModels[0].model.resultTextModel.uri));

			const hasUnhandledConflicts = inputModels.some((m) => m.model.hasUnhandledConflicts.get());

			const options: IDialogOptions = {
				cancelId: 2,
				detail:
					hasUnhandledConflicts
						? isMany
							? localize('detailNConflicts', "The files contain unhandled conflicts. The merge results will be lost if you don't save them.")
							: localize('detail1Conflicts', "The file contains unhandled conflicts. The merge result will be lost if you don't save it.")
						: isMany
							? localize('detailN', "The merge results will be lost if you don't save them.")
							: localize('detail1', "The merge result will be lost if you don't save it.")
			};

			const actions: string[] = [
				hasUnhandledConflicts ? localize('saveWithConflict', "Save With Conflicts") : localize('save', "Save"),
				localize('discard', "Don't Save"),
				localize('cancel', "Cancel"),
			];

			choice = (await this.dialogService.show(Severity.Info, message, actions, options)).choice;
		} else {
			choice = 1;
		}

		if (choice === 2) {
			// cancel: stay in editor
			return ConfirmResult.CANCEL;
		} else if (choice === 0) {
			// save with conflicts
			await Promise.all(inputModels.map(m => m.accept()));
			return ConfirmResult.SAVE; // Save is a no-op anyway
		} else {
			// discard changes
			await Promise.all(inputModels.map(m => m._discard()));
			return ConfirmResult.DONT_SAVE; // Revert is a no-op
		}
	}

	public async save(): Promise<void> {
		if (this.finished) {
			return;
		}
		// It does not make sense to save anything in the temp file mode.
		// The file stays dirty from the first edit on.

		(async () => {
			const result = await this.dialogService.show(
				Severity.Info,
				localize(
					'saveTempFile',
					"Do you want to accept the merge result? This will write the merge result to the original file and close the merge editor."
				),
				[
					localize('acceptMerge', 'Accept Merge'),
					localize('cancel', "Cancel"),
				],
				{ cancelId: 1 }
			);

			if (result.choice === 0) {
				await this.accept();
				const editors = this.editorService.findEditors(this.resultUri).filter(e => e.editor.typeId === 'mergeEditor.Input');
				await this.editorService.closeEditors(editors);
			}
		})();
	}

	public async revert(): Promise<void> {
		// no op
	}
}

/* ================ Workspace ================ */

export class WorkspaceMergeEditorModeFactory implements IMergeEditorInputModelFactory {
	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@ITextModelService private readonly _textModelService: ITextModelService,
		@ITextFileService private readonly textFileService: ITextFileService,
	) {
	}

	public async createInputModel(args: MergeEditorArgs): Promise<IMergeEditorInputModel> {
		const store = new DisposableStore();

		let resultTextFileModel: ITextFileEditorModel | undefined = undefined;
		const modelListener = store.add(new DisposableStore());
		const handleDidCreate = (model: ITextFileEditorModel) => {
			if (isEqual(args.result, model.resource)) {
				modelListener.clear();
				resultTextFileModel = model;
			}
		};
		modelListener.add(this.textFileService.files.onDidCreate(handleDidCreate));
		this.textFileService.files.models.forEach(handleDidCreate);

		const [
			base,
			result,
			input1Data,
			input2Data,
		] = await Promise.all([
			this._textModelService.createModelReference(args.base),
			this._textModelService.createModelReference(args.result),
			toInputData(args.input1, this._textModelService, store),
			toInputData(args.input2, this._textModelService, store),
		]);

		store.add(base);
		store.add(result);

		const diffProvider = this._instantiationService.createInstance(WorkerBasedDocumentDiffProvider);
		const model = this._instantiationService.createInstance(
			MergeEditorModel,
			base.object.textEditorModel,
			input1Data,
			input2Data,
			result.object.textEditorModel,
			this._instantiationService.createInstance(MergeDiffComputer, diffProvider),
			this._instantiationService.createInstance(MergeDiffComputer, this._instantiationService.createInstance(ProjectedDiffComputer, diffProvider))
		);
		store.add(model);

		if (!resultTextFileModel) {
			throw new BugIndicatingError();
		}

		return this._instantiationService.createInstance(WorkspaceMergeEditorInputModel, model, store, resultTextFileModel);
	}
}

class WorkspaceMergeEditorInputModel extends EditorModel implements IMergeEditorInputModel {
	public readonly isDirty = observableFromEvent(
		Event.any(this.resultTextFileModel.onDidChangeDirty, this.resultTextFileModel.onDidSaveError),
		() => /** @description isDirty */ this.resultTextFileModel.isDirty()
	);

	constructor(
		public readonly model: MergeEditorModel,
		private readonly disposableStore: DisposableStore,
		private readonly resultTextFileModel: ITextFileEditorModel
	) {
		super();
	}

	public override dispose(): void {
		this.disposableStore.dispose();
		super.dispose();
	}

	public async accept(): Promise<void> {
		await this.resultTextFileModel.save();
	}

	get resultUri(): URI {
		return this.resultTextFileModel.resource;
	}

	async save(): Promise<void> {
		await this.resultTextFileModel.save();
	}

	/**
	 * If save resets the dirty state, revert must do so too.
	*/
	async revert(): Promise<void> {
		await this.resultTextFileModel.revert();
	}

	shouldConfirmClose(): boolean {
		return false;
		//return this.resultTextFileModel.isDirty();
	}

	async confirmClose(inputModels: IMergeEditorInputModel[]): Promise<ConfirmResult> {
		return ConfirmResult.SAVE;
	}
}

/* ================= Utils ================== */

async function toInputData(data: MergeEditorInputData, textModelService: ITextModelService, store: DisposableStore): Promise<InputData> {
	const ref = await textModelService.createModelReference(data.uri);
	store.add(ref);
	return {
		textModel: ref.object.textEditorModel,
		title: data.title,
		description: data.description,
		detail: data.detail,
	};
}
