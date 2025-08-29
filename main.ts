import { Plugin, Notice, MarkdownView, TFile, Platform } from "obsidian";
import { Timer } from "src/Timer";
import { Controls } from "src/Controls";
import { AudioHandler } from "src/AudioHandler";
import { WhisperSettingsTab } from "src/WhisperSettingsTab";
import { SettingsManager, WhisperSettings } from "src/SettingsManager";
import { NativeAudioRecorder } from "src/AudioRecorder";
import { RecordingStatus, StatusBar } from "src/StatusBar";

import axios from "axios";

export default class Whisper extends Plugin {
    settings: WhisperSettings;
    settingsManager: SettingsManager;
    timer: Timer;
    recorder: NativeAudioRecorder;
    audioHandler: AudioHandler;
    controls: Controls | null = null;
    statusBar: StatusBar;
    debounceTimeout: number | null = null;

    async onload() {
        this.settingsManager = new SettingsManager(this);
        this.settings = await this.settingsManager.loadSettings();

        this.addRibbonIcon("activity", "Open recording controls", (evt) => {
            if (!this.controls) {
                this.controls = new Controls(this);
            }
            this.controls.open();
        });

        this.addSettingTab(new WhisperSettingsTab(this.app, this));

        this.timer = new Timer();
        this.audioHandler = new AudioHandler(this);
        this.recorder = new NativeAudioRecorder();

        this.statusBar = new StatusBar(this);

        this.addCommands();

        // Wait until the workspace is ready before running the scan-and-transcribe command
        this.app.workspace.onLayoutReady(() => {
            this.runScanAndTranscribe();
        });

        // Listen for file changes in the "Private/Dziennik 2025" folder
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                if (file.path.startsWith("Private/Dziennik 2025/")) {
                    this.debounceRunScanAndTranscribe();
                }
            })
        );
    }

    onunload() {
        if (this.controls) {
            this.controls.close();
        }

        this.statusBar.remove();
    }

    addCommands() {
        this.addCommand({
            id: "start-stop-recording",
            name: "Start/stop recording",
            callback: async () => {
                if (this.statusBar.status !== RecordingStatus.Recording) {
                    this.statusBar.updateStatus(RecordingStatus.Recording);
                    await this.recorder.startRecording();
                } else {
                    this.statusBar.updateStatus(RecordingStatus.Processing);
                    const audioBlob = await this.recorder.stopRecording();
                    const extension = this.recorder
                        .getMimeType()
                        ?.split("/")[1];
                    const fileName = `${new Date()
                        .toISOString()
                        .replace(/[:.]/g, "-")}.${extension}`;
                    // Use audioBlob to send or save the recorded audio as needed
                    await this.audioHandler.sendAudioData(audioBlob, fileName);
                    this.statusBar.updateStatus(RecordingStatus.Idle);
                }
            },
            hotkeys: [
                {
                    modifiers: ["Alt"],
                    key: "Q",
                },
            ],
        });

        this.addCommand({
            id: "upload-audio-file",
            name: "Upload audio file",
            callback: () => {
                // Create an input element for file selection
                const fileInput = document.createElement("input");
                fileInput.type = "file";
                fileInput.accept = "audio/*"; // Accept only audio files

                // Handle file selection
                fileInput.onchange = async (event) => {
                    const files = (event.target as HTMLInputElement).files;
                    if (files && files.length > 0) {
                        const file = files[0];
                        const fileName = file.name;
                        const audioBlob = file.slice(0, file.size, file.type);
                        // Use audioBlob to send or save the uploaded audio as needed
                        await this.audioHandler.sendAudioData(
                            audioBlob,
                            fileName
                        );
                    }
                };

                // Programmatically open the file dialog
                fileInput.click();
            },
        });

        this.addCommand({
            id: "scan-and-transcribe",
            name: "Scan and Transcribe Audio Files",
            callback: async () => {
                await this.scanAndTranscribeActiveNote();
            },
        });
    }

    debounceRunScanAndTranscribe() {
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }
        this.debounceTimeout = window.setTimeout(() => {
            this.runScanAndTranscribe();
        }, 10000); // 10 seconds debounce
    }

    async runScanAndTranscribe() {
        this.statusBar.updateStatus(RecordingStatus.Processing);

        const files = this.app.vault.getFiles().filter(file => {
            return file.path.startsWith("Private/Dziennik 2025/") && file.extension === "md";
        });

        if (files.length === 0) {
            new Notice("No files found in the directory.");
            this.statusBar.updateStatus(RecordingStatus.Idle);
            return;
        }

        for (const file of files) {
            await this.processFile(file);
        }

        new Notice("Transcription and analysis complete.");
        this.statusBar.updateStatus(RecordingStatus.Idle);
    }

    async scanAndTranscribeActiveNote() {
        this.statusBar.updateStatus(RecordingStatus.Processing);
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf || !activeLeaf.view || !(activeLeaf.view instanceof MarkdownView)) {
            new Notice("No active note found.");
            this.statusBar.updateStatus(RecordingStatus.Idle);
            return;
        }

        const noteContent = activeLeaf.view.getViewData();
        const audioFiles = this.extractAudioFiles(noteContent);
        const sourcePath = activeLeaf.view.file?.path ?? "";

        if (audioFiles.length === 0) {
            new Notice("No audio files found in the current note.");
            this.statusBar.updateStatus(RecordingStatus.Idle);
            return;
        }

        let updatedContent = await this.processAudioFiles(noteContent, audioFiles, sourcePath);
        activeLeaf.view.setViewData(updatedContent, false);
        new Notice("Transcription and analysis complete.");
        this.statusBar.updateStatus(RecordingStatus.Idle);
    }

    async processFile(file: TFile) {
        const noteContent = await this.app.vault.read(file);
        const audioFiles = this.extractAudioFiles(noteContent);

        if (audioFiles.length === 0) {
            return;
        }

        let updatedContent = await this.processAudioFiles(noteContent, audioFiles, file.path);
        await this.app.vault.modify(file, updatedContent);
    }

    async processAudioFiles(noteContent: string, audioFiles: string[], sourcePath: string): Promise<string> {
        let updatedContent = noteContent;

        for (const audioFile of audioFiles) {
            const resolvedPath = this.resolveAudioPath(audioFile, sourcePath);
            if (!resolvedPath) {
                console.error(`Could not resolve audio path for ${audioFile} (source: ${sourcePath})`);
                continue;
            }
            const audioBlob = await this.getAudioBlobFromPath(resolvedPath);
            if (audioBlob) {
                const resolvedFileName = resolvedPath.split('/').pop() ?? 'audio.m4a';
                const linkFileName = audioFile.split('/').pop();
                const transcription = await this.audioHandler.transcribeAudioRemote(audioBlob, resolvedFileName);
                if (transcription) {
                    const fileDate = await this.getFileCreationDateFromPath(resolvedPath);
                    const targetWithPath = `![[${audioFile}]]`;
                    const targetWithName = `![[${linkFileName}]]`;
                    const replacementWithPath = `${targetWithPath} #transcribed\n\n**Date:** ${fileDate}\n\n${transcription}`;
                    const replacementWithName = `${targetWithName} #transcribed\n\n**Date:** ${fileDate}\n\n${transcription}`;

                    if (updatedContent.includes(targetWithPath)) {
                        updatedContent = updatedContent.replace(targetWithPath, replacementWithPath);
                    } else if (updatedContent.includes(targetWithName)) {
                        updatedContent = updatedContent.replace(targetWithName, replacementWithName);
                    }
                    const analysis = await this.analyzeTranscription(transcription);
                    if (analysis) {
                        updatedContent += `\n\n**Tasks:**\n${analysis}`;
                    }
                }
            }
        }

        return updatedContent;
    }

    // Function to extract audio file links from the note content
    extractAudioFiles(content: string): string[] {
        const audioFiles: string[] = [];
        const lines = content.split('\n');
        for (const line of lines) {
            const match = line.match(/!\[\[([^\]]+)\]\]/);
            if (match && !line.includes('#transcribed')) {
                let target = match[1];
                // Strip alias and header fragments
                if (target.includes('|')) target = target.split('|')[0];
                if (target.includes('#')) target = target.split('#')[0];
                target = target.trim();
                if (/\.m4a$/i.test(target)) {
                    audioFiles.push(target);
                }
            }
        }
        return audioFiles;
    }

    // Function to get the audio blob from a resolved vault path
    async getAudioBlobFromPath(vaultPath: string): Promise<Blob | null> {
        try {
            const arrayBuffer = await this.app.vault.adapter.readBinary(vaultPath);
            const mime = this.getMimeFromExtension(vaultPath);
            return new Blob([arrayBuffer], { type: mime });
        } catch (error) {
            console.error("Error reading audio file:", error);
            return null;
        }
    }

    // Function to get the creation date of the audio file from a resolved vault path
    async getFileCreationDateFromPath(vaultPath: string): Promise<string> {
        try {
            const file = this.app.vault.getAbstractFileByPath(vaultPath) as TFile;
            if (file) {
                return new Date(file.stat.ctime).toLocaleString();
            } else {
                console.error(`File not found: ${vaultPath}`);
                return "Unknown date";
            }
        } catch (error) {
            console.error("Error getting file creation date:", error);
            return "Unknown date";
        }
    }

    // Try to resolve an audio path from a wiki link value
    resolveAudioPath(filePath: string, sourcePath: string): string | null {
        const normalized = filePath.replace(/^\/+/, "");
        // If the link already has directories, treat it as vault-relative
        if (normalized.includes("/")) {
            const exists = this.app.vault.getAbstractFileByPath(normalized);
            return exists ? normalized : null;
        }
        // Resolve using Obsidian link resolver from the source note
        const dest = this.app.metadataCache.getFirstLinkpathDest(
            normalized,
            sourcePath
        );
        if (dest) return dest.path;
        // Fallback to your fixed folder if resolver fails
        const candidate = `Private/Attachements/${normalized}`;
        const exists = this.app.vault.getAbstractFileByPath(candidate);
        return exists ? candidate : null;
    }

    getMimeFromExtension(path: string): string {
        const ext = (path.split(".").pop() || "").toLowerCase();
        switch (ext) {
            case "m4a":
                return "audio/mp4"; // common for m4a
            case "mp3":
                return "audio/mpeg";
            case "wav":
                return "audio/wav";
            case "ogg":
                return "audio/ogg";
            case "webm":
                return "audio/webm";
            case "aac":
                return "audio/aac";
            case "flac":
                return "audio/flac";
            default:
                return "application/octet-stream";
        }
    }



    // Function to analyze the transcription using OpenAI GPT model
    async analyzeTranscription(transcription: string): Promise<string | null> {
        if (!this.settings.apiKey) {
            new Notice("API key is missing. Please add your API key in the settings.");
            return null;
        }

        const messages = [
            {
                role: "system",
                content: `You are a helpful assistant called Stefan that can analyze my note transcription. 
                I will provide you with my transcription, please list all the tasks for me to do. 
                If there are no tasks to do, return an empty string.
                Answer in Polish`,
            },
            {
                role: "user",
                content: `${transcription}`,
            },
        ];

        try {
            const response = await axios.post(
                "https://api.openai.com/v1/chat/completions",
                {
                    model: "gpt-4o",
                    messages: messages,
                    response_format: {
                        type: "text",
                    },
                    temperature: 1,
                    max_completion_tokens: 10000,
                    top_p: 1,
                    frequency_penalty: 0,
                    presence_penalty: 0,
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${this.settings.apiKey}`,
                    },
                }
            );

            return response.data.choices[0].message.content.trim();
        } catch (err) {
            console.error("Error analyzing transcription:", err);
            new Notice("Error analyzing transcription: " + err.message);
            return null;
        }
    }

}
