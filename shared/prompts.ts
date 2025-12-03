import { PromptTemplate } from "@langchain/core/prompts";

export const VLM_PROMPT_TEMPLATE = {
  system:
    "You are an image analysis expert. Your task is to analyze the content of images and return results in JSON format.",
  user: PromptTemplate.fromTemplate(`Please analyze this image and return the result in JSON format.

The response should conform to this JSON Schema:
{vlm_response_schema}

Please return only valid JSON matching the schema, no other text.`),
};
