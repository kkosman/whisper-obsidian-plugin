import { Plugin } from "obsidian";


export interface WhisperSettings {
	apiKey: string;
	model: string;
	language: string;
	prompt: string;
	apiUrl: string;
	authHeader: string;
	saveAudioFile: boolean;
	saveAudioFilePath: string;
	createNewFileAfterRecording: boolean;
	createNewFileAfterRecordingPath: string;
	debugMode: boolean;
}

export const DEFAULT_SETTINGS: WhisperSettings = {
	apiKey: "",
	model: "whisper-1",
	language: "en",
	prompt: "",
	apiUrl: "https://api.openai.com/v1/audio/transcriptions",
	authHeader: "Basic XYZ12345",
	saveAudioFile: false,
	saveAudioFilePath: "",
	createNewFileAfterRecording: false,
	createNewFileAfterRecordingPath: "",
	debugMode: false
};

export class SettingsManager {
	plugin: Plugin;
	settings: WhisperSettings;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	async loadSettings() {
		const settings = await this.plugin.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
		return this.settings;
	}

	async saveSettings() {
		await this.plugin.saveData(this.settings);
	}
}
