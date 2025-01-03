import { Plugin, Notice, MarkdownView, TFile } from "obsidian";
import { Timer } from "src/Timer";
import { Controls } from "src/Controls";
import { AudioHandler } from "src/AudioHandler";
import { WhisperSettingsTab } from "src/WhisperSettingsTab";
import { SettingsManager, WhisperSettings } from "src/SettingsManager";
import { NativeAudioRecorder } from "src/AudioRecorder";
import { RecordingStatus, StatusBar } from "src/StatusBar";
import ffmpeg from "fluent-ffmpeg";
import { readFileSync, writeFileSync } from "fs";
import { Buffer } from "buffer";
import axios from "axios";

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
                this.statusBar.updateStatus(RecordingStatus.Processing);
                const activeLeaf = this.app.workspace.activeLeaf;
                if (!activeLeaf || !activeLeaf.view || !(activeLeaf.view instanceof MarkdownView)) {
                    new Notice("No active note found.");
                    return;
                }

                const noteContent = activeLeaf.view.getViewData();
                const audioFiles = this.extractAudioFiles(noteContent);

                if (audioFiles.length === 0) {
                    new Notice("No audio files found in the current note.");
                    return;
                }

                let updatedContent = noteContent;

                for (const audioFile of audioFiles) {
                    const audioBlob = await this.getAudioBlob(audioFile);
                    if (audioBlob) {
                        const compressedAudioBlob = await this.convertAndCompressAudio(audioBlob);
                        const transcription = await this.audioHandler.transcribeAudio(compressedAudioBlob);
                        if (transcription) {
                            const fileName = audioFile.split('/').pop(); // Extract the file name from the path
                            const analysis = await this.analyzeTranscription(transcription);
                            // Analyze the transcription
                            updatedContent = updatedContent.replace(
                                `![[${fileName}]]`,
                                `![[${fileName}]]\n\n${transcription}\n\n${analysis}`
                            );
                        }
                    }
                }

                activeLeaf.view.setViewData(updatedContent, false);
                new Notice("Transcription and analysis complete.");
                this.statusBar.updateStatus(RecordingStatus.Idle);
            },
        });
    }

    // Function to extract audio file links from the note content
    extractAudioFiles(content: string): string[] {
        const audioFilePattern = /!\[\[(.*?\.m4a)\]\]/g;
        const matches = content.matchAll(audioFilePattern);
        const audioFiles: string[] = [];
        for (const match of matches) {
            if (match[1]) {
                audioFiles.push(match[1]); // Return the file name only
            }
        }
        return audioFiles;
    }

    // Function to get the audio blob from the file path
    async getAudioBlob(filePath: string): Promise<Blob | null> {
        try {
            const arrayBuffer = await this.app.vault.adapter.readBinary("/Attachements/" + filePath);
            return new Blob([arrayBuffer]);
        } catch (error) {
            console.error("Error reading audio file:", error);
            return null;
        }
    }

    // Function to convert and compress the audio file
    async convertAndCompressAudio(inputBlob: Blob): Promise<Blob> {
        return new Promise((resolve, reject) => {
            const vaultPath = "/Users/krzysztofkosman/Obsidian/Private/Attachements";
            const inputFilePath = `${vaultPath}/input.m4a`;
            const outputFilePath = `${vaultPath}/output.mp3`;

            // Write the input blob to a file
            const reader = new FileReader();
            reader.onload = () => {
                const buffer = Buffer.from(reader.result as ArrayBuffer);
                writeFileSync(inputFilePath, buffer);

                // Use ffmpeg to convert and compress the audio file
                const ffmpegPath = "/Users/krzysztofkosman/Projects/whisper-obsidian-plugin/node_modules/ffmpeg-static/ffmpeg";
                console.log(`Using ffmpeg binary at: ${ffmpegPath}`);
                ffmpeg(inputFilePath)
                    .setFfmpegPath(ffmpegPath)
                    .audioCodec("libmp3lame")
                    .audioBitrate("64k")
                    .format("mp3")
                    .on("end", () => {
                        // Read the output file and resolve the promise with the resulting blob
                        const outputBuffer = readFileSync(outputFilePath);
                        const outputBlob = new Blob([outputBuffer], { type: "audio/mp3" });
                        resolve(outputBlob);
                    })
                    .on("error", (err: Error) => {
                        console.error("Error during ffmpeg processing:", err);
                        reject(err);
                    })
                    .save(outputFilePath);
            };
            reader.readAsArrayBuffer(inputBlob);
        });
    }

    // Function to analyze the transcription using OpenAI GPT-4.0-mini model
    async analyzeTranscription(transcription: string): Promise<string | null> {
        if (!this.settings.apiKey) {
            new Notice("API key is missing. Please add your API key in the settings.");
            return null;
        }

        const messages = [
            {
                role: "system",
                content: `You are a helpful assistant that can analyze my note transcription. 
                I will provide you with my transcription, please perform the following tasks:
                1. Briefly summarize the transcription.
                2. List all the tasks for me to do. If there are no tasks, skip this step.
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
                    model: "gpt-4o-mini",
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
