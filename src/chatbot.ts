import OpenAI from 'openai';
import { Embedder } from './embedder';
import { VectorStore, SearchResult } from './store';

export interface ChatbotConfig {
  openaiApiKey: string;
  embeddingModel: string;
  chatModel: string;
  maxContextChunks: number;
  temperature: number;
  maxTokens: number;
}

export interface ChatResponse {
  answer: string;
  sources: {
    filePath: string;
    chunkIndex: number;
    similarity: number;
    text: string;
  }[];
  model: string;
  tokensUsed?: number;
}

const DEFAULT_CONFIG: Partial<ChatbotConfig> = {
  embeddingModel: 'text-embedding-3-small',
  chatModel: 'gpt-4o-mini',
  maxContextChunks: 5,
  temperature: 0.1,
  maxTokens: 2000
};

export class Chatbot {
  private openai: OpenAI;
  private embedder: Embedder;
  private store: VectorStore;
  private config: ChatbotConfig;
  private readonly MAX_HISTORY_TOKENS = 2000;
  private readonly MAX_HISTORY_MESSAGES = 50;

  constructor(store: VectorStore, config: ChatbotConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = store;
    
    this.openai = new OpenAI({
      apiKey: this.config.openaiApiKey
    });

    this.embedder = new Embedder({
      apiKey: this.config.openaiApiKey,
      model: this.config.embeddingModel,
      maxRetries: 3,
      retryDelay: 1000
    });
  }

  async answerQuestion(question: string, repo?: string): Promise<ChatResponse> {
    if (!question.trim()) {
      throw new Error('Question cannot be empty');
    }

    try {
      console.log('Generating embedding for question...');
      const questionEmbedding = await this.embedder.getEmbedding(question);

      console.log('Searching for similar chunks...');
      const searchResults = await this.store.searchSimilar(
        questionEmbedding,
        this.config.maxContextChunks,
        repo
      );

      if (searchResults.length === 0) {
        return {
          answer: 'I couldn\'t find any relevant information in the repository to answer your question.',
          sources: [],
          model: this.config.chatModel
        };
      }

      console.log(`Found ${searchResults.length} relevant chunks`);
      const context = this.buildContext(searchResults);
      const prompt = this.buildPrompt(question, context);

      console.log('Generating answer...');
      const response = await this.openai.chat.completions.create({
        model: this.config.chatModel,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that answers questions about code repositories. Use the provided context to answer questions accurately and cite specific files when relevant.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens
      });

      const answer = response.choices[0]?.message?.content || 'I couldn\'t generate an answer.';
      
      const sources = searchResults.map(result => ({
        filePath: result.chunk.filePath,
        chunkIndex: result.chunk.chunkIndex,
        similarity: Math.round(result.similarity * 100) / 100,
        text: result.chunk.text.substring(0, 200) + (result.chunk.text.length > 200 ? '...' : '')
      }));

      return {
        answer,
        sources,
        model: this.config.chatModel,
        tokensUsed: response.usage?.total_tokens
      };

    } catch (error) {
      console.error('Error answering question:', error);
      throw new Error(`Failed to answer question: ${error}`);
    }
  }

  private buildContext(searchResults: SearchResult[]): string {
    return searchResults
      .map((result, index) => {
        const { chunk, similarity } = result;
        return `[Source ${index + 1}: ${chunk.filePath} (Similarity: ${Math.round(similarity * 100)}%)]\n${chunk.text}\n`;
      })
      .join('\n---\n\n');
  }

  private buildPrompt(question: string, context: string): string {
    return `Based on the following code repository context, please answer the user's question. If the context doesn't contain enough information to fully answer the question, say so clearly.

Context from repository:
${context}

---

Question: ${question}

Please provide a clear and accurate answer based on the provided context. If you reference specific code or files, mention the file path. If the context is insufficient to answer the question, explain what information is missing.`;
  }

  async chatWithHistory(
    question: string,
    conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [],
    repo?: string
  ): Promise<ChatResponse> {
    if (!question.trim()) {
      throw new Error('Question cannot be empty');
    }

    try {
      const questionEmbedding = await this.embedder.getEmbedding(question);
      const searchResults = await this.store.searchSimilar(
        questionEmbedding,
        this.config.maxContextChunks,
        repo
      );

      if (searchResults.length === 0) {
        return {
          answer: 'I couldn\'t find any relevant information in the repository to answer your question.',
          sources: [],
          model: this.config.chatModel
        };
      }

      const context = this.buildContext(searchResults);
      
      // Trim conversation history to fit within token limits
      const trimmedHistory = this.trimConversationHistory(conversationHistory, context, question);
      
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: `You are a helpful assistant that answers questions about code repositories. Use the provided context and conversation history to answer questions accurately. Here's the current repository context:\n\n${context}`
        },
        ...trimmedHistory.map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        })),
        {
          role: 'user',
          content: question
        }
      ];

      const response = await this.openai.chat.completions.create({
        model: this.config.chatModel,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens
      });

      const answer = response.choices[0]?.message?.content || 'I couldn\'t generate an answer.';
      
      const sources = searchResults.map(result => ({
        filePath: result.chunk.filePath,
        chunkIndex: result.chunk.chunkIndex,
        similarity: Math.round(result.similarity * 100) / 100,
        text: result.chunk.text.substring(0, 200) + (result.chunk.text.length > 200 ? '...' : '')
      }));

      return {
        answer,
        sources,
        model: this.config.chatModel,
        tokensUsed: response.usage?.total_tokens
      };

    } catch (error) {
      console.error('Error in chat with history:', error);
      throw new Error(`Failed to process chat: ${error}`);
    }
  }

  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  private trimConversationHistory(
    history: { role: 'user' | 'assistant'; content: string }[],
    context: string,
    question: string
  ): { role: 'user' | 'assistant'; content: string }[] {
    // First, enforce message count limit
    const recentHistory = history.slice(-this.MAX_HISTORY_MESSAGES);
    
    // Calculate tokens for fixed content
    const systemTokens = this.estimateTokens(`You are a helpful assistant that answers questions about code repositories. Use the provided context and conversation history to answer questions accurately. Here's the current repository context:\n\n${context}`);
    const questionTokens = this.estimateTokens(question);
    const responseTokens = this.config.maxTokens; // Reserve space for response
    
    const fixedTokens = systemTokens + questionTokens + responseTokens;
    const availableTokens = Math.max(0, this.MAX_HISTORY_TOKENS - fixedTokens);
    
    if (availableTokens <= 0) {
      return []; // No space for history
    }
    
    // Trim history from the beginning, keeping recent messages
    const trimmedHistory: { role: 'user' | 'assistant'; content: string }[] = [];
    let currentTokens = 0;
    
    // Process history in reverse order (most recent first)
    for (let i = recentHistory.length - 1; i >= 0; i--) {
      const msgTokens = this.estimateTokens(recentHistory[i].content);
      
      if (currentTokens + msgTokens <= availableTokens) {
        trimmedHistory.unshift(recentHistory[i]);
        currentTokens += msgTokens;
      } else {
        break; // Stop if adding this message would exceed limit
      }
    }
    
    return trimmedHistory;
  }

  async generateSummary(repo: string): Promise<string> {
    try {
      // Get repository stats without loading all chunks
      const stats = await this.store.getStats();
      if (!stats.repos.includes(repo)) {
        return 'Repository not found.';
      }

      // Sample chunks for analysis instead of loading all
      const SAMPLE_SIZE = 20;
      const sampleChunks = await this.getSampleChunks(repo, SAMPLE_SIZE);
      
      if (sampleChunks.length === 0) {
        return 'No content found for this repository.';
      }

      const filePaths = [...new Set(sampleChunks.map(chunk => chunk.filePath))];
      const fileTypes = [...new Set(filePaths.map(path => path.split('.').pop()).filter(Boolean))];
      
      // Limit content to prevent token overflow
      const maxContentLength = 2000;
      let currentLength = 0;
      const sampleContent = sampleChunks
        .map(chunk => {
          const content = `${chunk.filePath}:\n${chunk.text.substring(0, 200)}`;
          currentLength += content.length;
          return currentLength <= maxContentLength ? content : null;
        })
        .filter(Boolean)
        .join('\n\n---\n\n');

      const totalChunks = await this.getRepoChunkCount(repo);
      const prompt = `Analyze this code repository and provide a summary. The repository contains ${totalChunks} code chunks across ${filePaths.length}+ files with these file types: ${fileTypes.join(', ')}.

Sample content (limited):
${sampleContent}

Please provide a concise summary including:
1. What this project appears to be
2. Main technologies/languages used
3. Key components or modules
4. Overall architecture or purpose

Keep the summary under 300 words.`;

      const response = await this.openai.chat.completions.create({
        model: this.config.chatModel,
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant that analyzes code repositories and provides clear, concise summaries.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.1,
        max_tokens: 500
      });

      return response.choices[0]?.message?.content || 'Could not generate summary.';

    } catch (error) {
      console.error('Error generating summary:', error);
      throw new Error(`Failed to generate summary: ${error}`);
    }
  }

  private async getSampleChunks(repo: string, sampleSize: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT * FROM chunks 
        WHERE repo = ? 
        ORDER BY RANDOM() 
        LIMIT ?
      `;
      
      this.store.getDatabase().all(sql, [repo, sampleSize], (err: Error | null, rows: any[]) => {
        if (err) {
          reject(new Error(`Failed to get sample chunks: ${err.message}`));
          return;
        }
        
        try {
          const chunks = rows.map(row => ({
            id: row.id,
            repo: row.repo,
            filePath: row.file_path,
            chunkIndex: row.chunk_index,
            text: row.text,
            embedding: JSON.parse(row.embedding),
            createdAt: row.created_at
          }));
          resolve(chunks);
        } catch (parseErr) {
          reject(new Error(`Failed to parse sample chunks: ${parseErr}`));
        }
      });
    });
  }

  private async getRepoChunkCount(repo: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT COUNT(*) as count FROM chunks WHERE repo = ?';
      
      this.store.getDatabase().get(sql, [repo], (err: Error | null, row: any) => {
        if (err) {
          reject(new Error(`Failed to get chunk count: ${err.message}`));
          return;
        }
        resolve(row.count || 0);
      });
    });
  }
}