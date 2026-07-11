declare module 'storybook/preview-api' {
  interface MakeDecorator {
    (options: {
      name: string;
      parameterName: string;
      skipIfNoParametersOrOptions: boolean;
      wrapper: (getStory: any, context: any, args: { parameters: any; options: any }) => any;
    }): (getStory: any, context: any) => any;
  }

  export const makeDecorator: MakeDecorator;
}
