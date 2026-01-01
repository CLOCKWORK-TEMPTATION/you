#!/usr/bin/env ts-node

/**
 * YouTube Playlist Extractor - TypeScript Edition
 * Supports CLI mode and MCP Server mode (SSE)
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { google, youtube_v3 } from 'googleapis';
import { Command } from 'commander';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { stringify } from 'csv-stringify/sync';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

// ==========================================
// إعدادات التسجيل (Logging Configuration)
// ==========================================
class AppLogger {
  private static logFile = 'cli_tool.log';

  static log(level: 'INFO' | 'ERROR' | 'DEBUG', message: string) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `${timestamp} - ${level} - ${message}`;
    
    // طباعة للشاشة
    if (level === 'ERROR') {
      console.error(formattedMessage);
    } else {
      console.log(formattedMessage);
    }

    // كتابة للملف
    fs.appendFileSync(this.logFile, formattedMessage + '\n', { encoding: 'utf8' });
  }

  static info(message: string) {
    this.log('INFO', message);
  }

  static error(message: string) {
    this.log('ERROR', message);
  }

  static debug(message: string, verbose: boolean) {
    if (verbose) {
      this.log('DEBUG', message);
    }
  }
}

// ==========================================
// مدير الإعدادات (Configuration Manager)
// ==========================================
interface ConfigData {
  api_key?: string;
}

class ConfigManager {
  private static CONFIG_FILE = 'cli_config.json';

  static loadConfig(): ConfigData {
    if (fs.existsSync(this.CONFIG_FILE)) {
      try {
        const raw = fs.readFileSync(this.CONFIG_FILE, 'utf-8');
        return JSON.parse(raw);
      } catch (e: any) {
        AppLogger.error(`فشل تحميل ملف الإعدادات: ${e.message}`);
      }
    }
    return {};
  }

  static saveConfig(data: ConfigData) {
    try {
      const current = this.loadConfig();
      const updated = { ...current, ...data };
      fs.writeFileSync(this.CONFIG_FILE, JSON.stringify(updated, null, 4), 'utf-8');
    } catch (e: any) {
      AppLogger.error(`فشل حفظ الإعدادات: ${e.message}`);
    }
  }
}

// ==========================================
// المحرك الأساسي (Core Logic)
// ==========================================
interface VideoItem {
  title: string;
  url: string;
  video_id: string;
  published_at: string;
}

class YouTubeExtractor {
  private youtube: youtube_v3.Youtube;

  constructor(apiKey: string) {
    this.youtube = google.youtube({
      version: 'v3',
      auth: apiKey,
    });
  }

  extractPlaylistId(url: string): string | null {
    const patterns = [
      /list=([a-zA-Z0-9_-]+)/,
      /playlist\?list=([a-zA-Z0-9_-]+)/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) return match[1];
    }

    // افتراض أن المدخل هو ID مباشر إذا لم يكن رابطاً
    if (url.length > 10 && !url.includes('http')) {
      return url;
    }
    return null;
  }

  async getPlaylistVideos(playlistId: string): Promise<VideoItem[]> {
    const videos: VideoItem[] = [];
    let nextPageToken: string | undefined = undefined;

    AppLogger.info(`جاري سحب البيانات للقائمة: ${playlistId}`);

    try {
      do {
        const response: any = await this.youtube.playlistItems.list({
          part: ['snippet'],
          playlistId: playlistId,
          maxResults: 50,
          pageToken: nextPageToken,
        });

        const items = response.data.items || [];
        for (const item of items) {
          const snippet = item.snippet;
          if (!snippet) continue;

          const videoId = snippet.resourceId?.videoId;
          if (videoId) {
            videos.push({
              title: snippet.title || 'Unknown',
              url: `https://www.youtube.com/watch?v=${videoId}`,
              video_id: videoId,
              published_at: snippet.publishedAt || '',
            });
          }
        }

        nextPageToken = response.data.nextPageToken || undefined;
        if (nextPageToken) {
          AppLogger.info(`تم جلب ${videos.length} فيديو حتى الآن...`);
        }

      } while (nextPageToken);

      return videos;

    } catch (e: any) {
      throw new Error(`YouTube API Error: ${e.message}`);
    }
  }
}

// ==========================================
// خادم MCP (MCP Server Logic)
// ==========================================
class MCPServerHandler {
  private app: express.Application;
  private mcpServer: Server;
  private extractor: YouTubeExtractor;

  constructor(port: number, apiKey: string) {
    this.extractor = new YouTubeExtractor(apiKey);
    this.app = express();
    this.app.use(cors());

    // إعداد خادم MCP
    this.mcpServer = new Server(
      {
        name: "youtube-playlist-extractor",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupTools();
    this.setupRoutes(port);
  }

  private setupTools() {
    // تعريف قائمة الأدوات
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "get_playlist_videos",
            description: "Extract all video titles and URLs from a YouTube playlist URL. Use this tool when the user provides a YouTube playlist link and asks for its content.",
            inputSchema: {
              type: "object",
              properties: {
                playlist_url: {
                  type: "string",
                  description: "The full URL of the YouTube playlist or the playlist ID."
                }
              },
              required: ["playlist_url"]
            }
          }
        ]
      };
    });

    // تنفيذ الأداة عند الطلب
    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "get_playlist_videos") {
        const args = request.params.arguments as { playlist_url?: string };
        const url = args.playlist_url;

        if (!url) {
          return {
            content: [{ type: "text", text: "Error: playlist_url is required" }]
          };
        }

        try {
          const playlistId = this.extractor.extractPlaylistId(url);
          if (!playlistId) {
            return {
              content: [{ type: "text", text: "Error: Invalid playlist URL" }]
            };
          }

          const videos = await this.extractor.getPlaylistVideos(playlistId);
          
          let resultText = `Found ${videos.length} videos in playlist:\n`;
          videos.forEach((v, idx) => {
            resultText += `${idx + 1}. ${v.title} (${v.url})\n`;
          });

          return {
            content: [{ type: "text", text: resultText }]
          };

        } catch (e: any) {
          return {
            content: [{ type: "text", text: `Error processing request: ${e.message}` }]
          };
        }
      }

      throw new Error(`Tool not found: ${request.params.name}`);
    });
  }

  private setupRoutes(port: number) {
    let transport: SSEServerTransport;

    this.app.get('/sse', async (req: Request, res: Response) => {
      AppLogger.info("New SSE connection established");
      transport = new SSEServerTransport("/messages", res);
      await this.mcpServer.connect(transport);
    });

    this.app.post('/messages', async (req: Request, res: Response) => {
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).json({ error: "No active transport" });
      }
    });

    this.app.listen(port, () => {
      AppLogger.info(`=== MCP Server Running ===`);
      AppLogger.info(`Server URL for HuggingChat: http://localhost:${port}/sse`);
    });
  }
}

// ==========================================
// واجهة سطر الأوامر (CLI Handler)
// ==========================================
async function main() {
  // Load environment variables
  dotenv.config();
  
  const program = new Command();

  program
    .name('youtube-playlist-ts')
    .description('YouTube Playlist Extractor Tool & MCP Server')
    .option('--url <url>', 'Playlist URL or ID')
    .option('--key <key>', 'YouTube Data API Key')
    .option('--output <file>', 'Output filename')
    .option('--format <format>', 'Output format (csv, json, txt)', 'csv')
    .option('--save-key', 'Save API key to config file')
    .option('--server', 'Run as MCP Server')
    .option('--port <port>', 'Server port', '8000')
    .option('--verbose', 'Enable verbose logging');

  program.parse(process.argv);
  const options = program.opts();

  // إعداد الإعدادات
  const config = ConfigManager.loadConfig();
  const apiKey = options.key || config.api_key || process.env.YOUTUBE_API_KEY;
  const verbose = !!options.verbose;

  if (!apiKey) {
    AppLogger.error("مطلوب مفتاح API. استخدم --key 'YOUR_KEY'");
    process.exit(1);
  }

  if (options.saveKey && options.key) {
    ConfigManager.saveConfig({ api_key: options.key });
    AppLogger.info("تم حفظ مفتاح API بنجاح.");
  }

  // === وضع الخادم (Server Mode) ===
  if (options.server) {
    const port = parseInt(options.port, 10);
    new MCPServerHandler(port, apiKey);
    // Keeping process alive
    return; 
  }

  // === وضع سطر الأوامر (CLI Mode) ===
  if (!options.url) {
    AppLogger.error("يجب توفير رابط القائمة باستخدام --url أو تشغيل الخادم باستخدام --server");
    process.exit(1);
  }

  try {
    const extractor = new YouTubeExtractor(apiKey);
    const playlistId = extractor.extractPlaylistId(options.url);

    if (!playlistId) {
      AppLogger.error("رابط القائمة غير صالح.");
      process.exit(1);
    }

    const videos = await extractor.getPlaylistVideos(playlistId);
    AppLogger.info(`تم الانتهاء! إجمالي الفيديوهات: ${videos.length}`);

    // التصدير
    const outputFormat = options.format;
    const outputFile = options.output || `playlist_${playlistId}.${outputFormat}`;

    let content = '';
    if (outputFormat === 'csv') {
      content = stringify(videos, { header: true });
    } else if (outputFormat === 'json') {
      content = JSON.stringify(videos, null, 4);
    } else {
      content = videos.map(v => `${v.title} - ${v.url}`).join('\n');
    }

    fs.writeFileSync(outputFile, content, 'utf-8');
    AppLogger.info(`تم حفظ البيانات في الملف: ${outputFile}`);

  } catch (e: any) {
    AppLogger.error(`حدث خطأ: ${e.message}`);
    process.exit(1);
  }
}

// تشغيل البرنامج
main().catch((e) => {
  console.error("Fatal Error:", e);

});

