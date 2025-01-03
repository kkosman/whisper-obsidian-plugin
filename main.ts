import { Plugin, Notice } from "obsidian";
import { Timer } from "src/Timer";
import { Controls } from "src/Controls";
import { AudioHandler } from "src/AudioHandler";
import { WhisperSettingsTab } from "src/WhisperSettingsTab";
import { SettingsManager, WhisperSettings } from "src/SettingsManager";
import { NativeAudioRecorder } from "src/AudioRecorder";
import { RecordingStatus, StatusBar } from "src/StatusBar";

export default class Whisper extends Plugin {
    settings: WhisperSettings;
    settingsManager: SettingsManager;
    timer: Timer;
    recorder: NativeAudioRecorder;
    audioHandler: AudioHandler;
    controls: Controls | null = null;
    statusBar: StatusBar;

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
                const activeLeaf = this.app.workspace.activeLeaf;
                if (!activeLeaf || !activeLeaf.view || !activeLeaf.view instanceof MarkdownView) {
                    new Notice("No active note found.");
                    return;
                }
                
                const noteContent = activeLeaf.view.data;
                const audioFiles = this.extractAudioFiles(noteContent);
                
                if (audioFiles.length === 0) {
                    new Notice("No audio files found in the current note.");
                    return;
                }

                for (const audioFile of audioFiles) {
                    const audioBlob = await this.getAudioBlob(audioFile);
                    if (audioBlob) {
                        await this.audioHandler.sendAudioData(audioBlob, audioFile);
                    }
                }

                new Notice("Transcription complete.");
            },
        });
    }

    // Function to extract audio file links from the note content
    extractAudioFiles(content: string): string[] {
        const audioFilePattern = /\[audio\]\((.*?)\)/g;
        const matches = content.matchAll(audioFilePattern);
        const audioFiles: string[] = [];
        for (const match of matches) {
            if (match[1]) {
                audioFiles.push(match[1]);
            }
        }
        return audioFiles;
    }

    // Function to get the audio blob from the file path
    async getAudioBlob(filePath: string): Promise<Blob | null> {
        try {
            const arrayBuffer = await this.app.vault.adapter.readBinary(filePath);
            return new Blob([arrayBuffer]);
        } catch (error) {
            console.error("Error reading audio file:", error);
            return null;
        }
    }
}
