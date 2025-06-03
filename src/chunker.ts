export interface ChunkConfig {
  maxTokens: number;
  overlap: number;
  separators: string[];
}

export interface Chunk {
  text: string;
  index: number;
  filePath: string;
  startPosition: number;
  endPosition: number;
}

const DEFAULT_CONFIG: ChunkConfig = {
  maxTokens: 1000,
  overlap: 200,
  separators: ['\n\n', '\n', '. ', ' ']
};

export class Chunker {
  private config: ChunkConfig;

  constructor(config: Partial<ChunkConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private splitBySeparator(text: string, separator: string, maxTokens: number): string[] {
    const parts = text.split(separator);
    const chunks: string[] = [];
    let currentChunk = '';

    for (const part of parts) {
      const testChunk = currentChunk + (currentChunk ? separator : '') + part;
      
      if (this.estimateTokens(testChunk) <= maxTokens) {
        currentChunk = testChunk;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        currentChunk = part;
        
        if (this.estimateTokens(currentChunk) > maxTokens) {
          const subChunks = this.splitLongText(currentChunk, maxTokens);
          chunks.push(...subChunks.slice(0, -1));
          currentChunk = subChunks[subChunks.length - 1] || '';
        }
      }
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  private splitLongText(text: string, maxTokens: number): string[] {
    const chunkSize = Math.floor(maxTokens * 4);
    const chunks: string[] = [];
    
    for (let i = 0; i < text.length; i += chunkSize) {
      chunks.push(text.slice(i, i + chunkSize));
    }
    
    return chunks;
  }

  chunkText(text: string, filePath: string): Chunk[] {
    if (!text.trim()) {
      return [];
    }

    let chunks: string[] = [text];

    for (const separator of this.config.separators) {
      const newChunks: string[] = [];
      
      for (const chunk of chunks) {
        if (this.estimateTokens(chunk) <= this.config.maxTokens) {
          newChunks.push(chunk);
        } else {
          newChunks.push(...this.splitBySeparator(chunk, separator, this.config.maxTokens));
        }
      }
      
      chunks = newChunks;
      
      const allSmallEnough = chunks.every(chunk => this.estimateTokens(chunk) <= this.config.maxTokens);
      if (allSmallEnough) {
        break;
      }
    }

    const finalChunks = this.addOverlap(chunks);
    
    return finalChunks.map((chunk, index) => ({
      text: chunk.trim(),
      index,
      filePath,
      startPosition: 0,
      endPosition: chunk.length
    })).filter(chunk => chunk.text.length > 0);
  }

  private addOverlap(chunks: string[]): string[] {
    if (chunks.length <= 1 || this.config.overlap === 0) {
      return chunks;
    }

    const chunksWithOverlap: string[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      let chunkText = chunks[i];
      
      if (i > 0) {
        const prevChunk = chunks[i - 1];
        const overlapTokens = Math.min(this.config.overlap, this.estimateTokens(prevChunk));
        const overlapLength = overlapTokens * 4;
        const overlap = prevChunk.slice(-overlapLength);
        chunkText = overlap + ' ' + chunkText;
      }
      
      chunksWithOverlap.push(chunkText);
    }
    
    return chunksWithOverlap;
  }

  *chunkFilesIterative(files: { filePath: string; content: string; relativePath: string }[]): Generator<Chunk, void, unknown> {
    for (const file of files) {
      const fileChunks = this.chunkText(file.content, file.relativePath);
      for (const chunk of fileChunks) {
        yield chunk;
      }
    }
  }

  chunkFiles(files: { filePath: string; content: string; relativePath: string }[]): Chunk[] {
    const allChunks: Chunk[] = [];
    
    for (const file of files) {
      const fileChunks = this.chunkText(file.content, file.relativePath);
      allChunks.push(...fileChunks);
    }
    
    return allChunks;
  }
}