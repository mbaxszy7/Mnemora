1. 整个plan中的所有scheduler，包括请求llm vlm embedding，ocr text，都不需要指数退避，都遵循一份全局的配置：最大重试2次，1分钟后重试
