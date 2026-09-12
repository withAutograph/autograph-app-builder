declare module "*.png" {
  const image: {
    src: string;
    height: number;
    width: number;
    blurDataURL?: string;
    blurHeight?: number;
    blurWidth?: number;
  };
  export default image;
}
