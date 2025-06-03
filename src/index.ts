import dotenv from 'dotenv';
import { GitLoader } from './gitLoader';
import { Chunker, Chunk } from './chunker';
import { Embedder } from './embedder';
import { VectorStore } from './store';
import { Chatbot } from './chatbot';
import * as readline from 'readline';
import path from 'path';

dotenv.config();

interface Config {
  openaiApiKey: string;
  databasePath: string;
  embeddingModel: string;
  chatModel: string;
  maxChunkSize: number;
  chunkOverlap: number;
}

function getConfig(): Config {
  const config: Config = {
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    databasePath: process.env.DATABASE_PATH || './data/chatbot.db',
    embeddingModel: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    chatModel: process.env.CHAT_MODEL || 'gpt-4o-mini',
    maxChunkSize: parseInt(process.env.MAX_CHUNK_SIZE || '1000'),
    chunkOverlap: parseInt(process.env.CHUNK_OVERLAP || '200')
  };

  if (!config.openaiApiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  return config;
}

async function indexRepository(repoUrl: string, repoName: string, localPath: string): Promise<void> {
  const config = getConfig();
  const BATCH_SIZE = 50; // Process files in batches
  const EMBEDDING_BATCH_SIZE = 20; // Embedding API batch size
  
  console.log(`\n🔄 Starting indexing process for ${repoName}...`);
  
  const gitLoader = new GitLoader();
  const chunker = new Chunker({
    maxTokens: config.maxChunkSize,
    overlap: config.chunkOverlap
  });
  const embedder = new Embedder({
    apiKey: config.openaiApiKey,
    model: config.embeddingModel,
    maxRetries: 3,
    retryDelay: 1000
  });
  const store = new VectorStore(config.databasePath);

  try {
    await store.initialize();
    
    console.log('📥 Loading repository files...');
    let totalFiles = 0;
    const files: { filePath: string; content: string; relativePath: string }[] = [];
    
    for await (const file of gitLoader.loadRepositoryStream(repoUrl, localPath)) {
      files.push(file);
      totalFiles++;
      if (totalFiles % 100 === 0) {
        console.log(`Loaded ${totalFiles} files...`);
      }
    }
    console.log(`Found ${files.length} files`);

    console.log('💾 Clearing existing repository data...');
    await store.deleteRepo(repoName);

    let totalChunks = 0;
    let processedFiles = 0;

    // Process files in batches to manage memory
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const fileBatch = files.slice(i, i + BATCH_SIZE);
      
      console.log(`✂️  Processing files ${i + 1}-${Math.min(i + BATCH_SIZE, files.length)} of ${files.length}...`);
      
      // Chunk current batch of files
      const chunks: Chunk[] = [];
      for (const chunk of chunker.chunkFilesIterative(fileBatch)) {
        chunks.push(chunk);
      }
      
      if (chunks.length === 0) {
        processedFiles += fileBatch.length;
        continue;
      }

      console.log(`🧠 Generating embeddings for ${chunks.length} chunks...`);
      
      // Process embeddings in smaller batches
      const allEmbeddings: number[][] = [];
      for (let j = 0; j < chunks.length; j += EMBEDDING_BATCH_SIZE) {
        const chunkBatch = chunks.slice(j, j + EMBEDDING_BATCH_SIZE);
        const embeddings = await embedder.getBatchEmbeddings(
          chunkBatch.map(chunk => chunk.text),
          EMBEDDING_BATCH_SIZE
        );
        allEmbeddings.push(...embeddings);
        
        // Small delay to avoid rate limiting
        if (j + EMBEDDING_BATCH_SIZE < chunks.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      console.log(`💾 Saving ${chunks.length} chunks to database...`);
      await store.saveChunks(repoName, chunks, allEmbeddings);
      
      totalChunks += chunks.length;
      processedFiles += fileBatch.length;
      
      // Force garbage collection hint
      if (global.gc) {
        global.gc();
      }
      
      console.log(`✓ Processed ${processedFiles}/${files.length} files (${totalChunks} total chunks)`);
    }

    console.log(`✅ Successfully indexed ${repoName}! Created ${totalChunks} chunks from ${processedFiles} files`);
    
    const stats = await store.getStats();
    console.log(`📊 Database stats: ${stats.totalChunks} chunks across ${stats.repoCount} repositories`);

  } catch (error) {
    console.error('❌ Error during indexing:', error);
    throw error;
  } finally {
    try {
      await store.close();
    } catch (closeError) {
      console.warn('Warning: Failed to close database:', closeError);
    }
  }
}

async function startChatInterface(repo?: string): Promise<void> {
  const config = getConfig();
  const store = new VectorStore(config.databasePath);
  
  try {
    await store.initialize();
    
    const chatbot = new Chatbot(store, {
      openaiApiKey: config.openaiApiKey,
      embeddingModel: config.embeddingModel,
      chatModel: config.chatModel,
      maxContextChunks: 5,
      temperature: 0.1,
      maxTokens: 2000
    });

    const stats = await store.getStats();
    
    if (stats.totalChunks === 0) {
      console.log('❌ No repositories have been indexed yet. Please index a repository first.');
      return;
    }

    console.log(`\n🤖 GitHub Repository QA Chatbot`);
    console.log(`📊 Database contains ${stats.totalChunks} chunks from ${stats.repoCount} repositories`);
    console.log(`📚 Available repositories: ${stats.repos.join(', ')}`);
    
    if (repo) {
      console.log(`🎯 Focused on repository: ${repo}`);
    } else {
      console.log(`🌐 Searching across all repositories`);
    }
    
    console.log(`\nType your questions below (or 'quit' to exit, 'summary' for repo summary):\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];

    const askQuestion = () => {
      rl.question('❓ Question: ', async (question) => {
        if (question.toLowerCase() === 'quit' || question.toLowerCase() === 'exit') {
          console.log('👋 Goodbye!');
          rl.close();
          await store.close();
          return;
        }

        if (question.toLowerCase() === 'summary') {
          if (repo) {
            try {
              console.log('\n🔍 Generating repository summary...');
              const summary = await chatbot.generateSummary(repo);
              console.log(`\n📝 Summary of ${repo}:`);
              console.log(summary);
            } catch (error) {
              console.error('❌ Error generating summary:', error);
            }
          } else {
            console.log('❌ Please specify a repository for summary generation');
          }
          console.log('');
          askQuestion();
          return;
        }

        if (!question.trim()) {
          askQuestion();
          return;
        }

        try {
          console.log('\n🤔 Thinking...');
          const response = await chatbot.chatWithHistory(question, conversationHistory, repo);
          
          console.log(`\n🤖 Answer:`);
          console.log(response.answer);
          
          if (response.sources.length > 0) {
            console.log(`\n📚 Sources:`);
            response.sources.forEach((source, index) => {
              console.log(`${index + 1}. ${source.filePath} (${source.similarity}% similarity)`);
            });
          }

          if (response.tokensUsed) {
            console.log(`\n📊 Tokens used: ${response.tokensUsed}`);
          }

          conversationHistory.push({ role: 'user', content: question });
          conversationHistory.push({ role: 'assistant', content: response.answer });

          // Token-aware history trimming is now handled in chatbot.chatWithHistory

        } catch (error) {
          console.error('❌ Error answering question:', error);
        }

        console.log('');
        askQuestion();
      });
    };

    askQuestion();

  } catch (error) {
    console.error('❌ Error starting chat interface:', error);
    try {
      await store.close();
    } catch (closeError) {
      console.warn('Warning: Failed to close database:', closeError);
    }
    throw error;
  }
}

async function showHelp(): Promise<void> {
  console.log(`
GitHub Repository QA Chatbot

Usage:
  npm run dev index <repo-url> <repo-name> [local-path]  - Index a repository
  npm run dev chat [repo-name]                          - Start chat interface
  npm run dev stats                                     - Show database statistics
  npm run dev help                                      - Show this help

Examples:
  npm run dev index https://github.com/user/repo my-repo ./repos/my-repo
  npm run dev chat my-repo
  npm run dev chat

Environment Variables:
  OPENAI_API_KEY     - Your OpenAI API key (required)
  DATABASE_PATH      - Path to SQLite database (default: ./data/chatbot.db)
  EMBEDDING_MODEL    - OpenAI embedding model (default: text-embedding-ada-002)
  CHAT_MODEL         - OpenAI chat model (default: gpt-4-turbo-preview)
  MAX_CHUNK_SIZE     - Maximum tokens per chunk (default: 1000)
  CHUNK_OVERLAP      - Overlap between chunks (default: 200)
`);
}

async function showStats(): Promise<void> {
  const config = getConfig();
  const store = new VectorStore(config.databasePath);
  
  try {
    await store.initialize();
    const stats = await store.getStats();
    
    console.log(`\n📊 Database Statistics:`);
    console.log(`   Total chunks: ${stats.totalChunks}`);
    console.log(`   Repositories: ${stats.repoCount}`);
    
    if (stats.repos.length > 0) {
      console.log(`   Available repos:`);
      for (const repo of stats.repos) {
        const chunks = await store.getChunksByRepo(repo);
        console.log(`     - ${repo}: ${chunks.length} chunks`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error retrieving stats:', error);
    throw error;
  } finally {
    try {
      await store.close();
    } catch (closeError) {
      console.warn('Warning: Failed to close database:', closeError);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'index':
      if (args.length < 3) {
        console.error('Usage: npm run dev index <repo-url> <repo-name> [local-path]');
        process.exit(1);
      }
      const repoUrl = args[1];
      const repoName = args[2];
      const localPath = args[3] || path.join('./repos', repoName);
      await indexRepository(repoUrl, repoName, localPath);
      break;

    case 'chat':
      const repo = args[1];
      await startChatInterface(repo);
      break;

    case 'stats':
      await showStats();
      break;

    case 'help':
    default:
      await showHelp();
      break;
  }
}

if (require.main === module) {
  main().catch(console.error);
}