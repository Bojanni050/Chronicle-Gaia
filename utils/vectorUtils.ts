
/**
 * Calculates the cosine similarity between two vectors.
 * Returns a value between -1 and 1, where 1 is identical direction.
 */
export const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
  if (vecA.length !== vecB.length) {
    throw new Error("Vectors must have the same dimensionality");
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magnitudeA += vecA[i] * vecA[i];
    magnitudeB += vecB[i] * vecB[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
};

/**
 * Finds the top K most similar items from a dataset based on a target vector.
 */
export const findNearestNeighbors = <T extends { embedding?: number[] }>(
  targetVector: number[],
  items: T[],
  k: number = 5
): { item: T; score: number }[] => {
  const scores = items
    .filter(item => item.embedding && item.embedding.length > 0)
    .map(item => ({
      item,
      score: cosineSimilarity(targetVector, item.embedding!)
    }));

  // Sort descending by score (highest similarity first)
  return scores.sort((a, b) => b.score - a.score).slice(0, k);
};
