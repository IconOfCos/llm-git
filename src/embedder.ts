import OpenAI from 'openai';

export interface EmbedderConfig {
  apiKey: string;
  model: string;
  maxRetries: number;
  retryDelay: number;
}

const DEFAULT_CONFIG: Partial<EmbedderConfig> = {
  model: 'text-embedding-3-small',
  maxRetries: 3,
  retryDelay: 1000
};

export class Embedder {
  private openai: OpenAI;
  private config: EmbedderConfig;

  constructor(config: EmbedderConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.openai = new OpenAI({
      apiKey: this.config.apiKey
    });
  }

  async getEmbedding(text: string): Promise<number[]> {
    if (!text.trim()) {
      throw new Error('Text cannot be empty');
    }

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const response = await this.openai.embeddings.create({
          model: this.config.model,
          input: text.replace(/\n/g, ' ').trim(),
          encoding_format: 'float'
        });

        if (response.data && response.data.length > 0) {
          return response.data[0].embedding;
        } else {
          throw new Error('No embedding returned from API');
        }
      } catch (error) {
        console.warn(`Embedding attempt ${attempt + 1} failed:`, error);
        
        if (attempt === this.config.maxRetries - 1) {
          throw new Error(`Failed to get embedding after ${this.config.maxRetries} attempts: ${error}`);
        }
        
        await this.delay(this.config.retryDelay * Math.pow(2, attempt));
      }
    }

    throw new Error('Unexpected error in getEmbedding');
  }

  async getEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    
    for (let i = 0; i < texts.length; i++) {
      try {
        console.log(`Processing embedding ${i + 1}/${texts.length}`);
        const embedding = await this.getEmbedding(texts[i]);
        embeddings.push(embedding);
        
        if (i < texts.length - 1) {
          await this.delay(200);
        }
      } catch (error) {
        console.error(`Failed to get embedding for text ${i}:`, error);
        throw error;
      }
    }
    
    return embeddings;
  }

  async getBatchEmbeddings(texts: string[], batchSize: number = 10): Promise<number[][]> {
    const results: number[][] = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(texts.length/batchSize)}`);
      
      try {
        const response = await this.openai.embeddings.create({
          model: this.config.model,
          input: batch.map(text => text.replace(/\n/g, ' ').trim()),
          encoding_format: 'float'
        });

        if (response.data && response.data.length === batch.length) {
          const batchEmbeddings = response.data.map(item => item.embedding);
          results.push(...batchEmbeddings);
        } else {
          throw new Error(`Batch embedding failed: expected ${batch.length} embeddings, got ${response.data?.length || 0}`);
        }
        
        if (i + batchSize < texts.length) {
          await this.delay(2000);
        }
      } catch (error) {
        console.error(`Batch embedding failed, falling back to individual requests:`, error);
        const individualEmbeddings = await this.getEmbeddings(batch);
        results.push(...individualEmbeddings);
      }
    }
    
    return results;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  calculateSimilarity(embedding1: number[], embedding2: number[]): number {
    if (embedding1.length !== embedding2.length) {
      throw new Error('Embeddings must have the same dimension');
    }

    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < embedding1.length; i++) {
      dotProduct += embedding1[i] * embedding2[i];
      norm1 += embedding1[i] * embedding1[i];
      norm2 += embedding2[i] * embedding2[i];
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    if (norm1 === 0 || norm2 === 0) {
      return 0;
    }

    return dotProduct / (norm1 * norm2);
  }
}